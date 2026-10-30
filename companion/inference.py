"""Bounded, in-memory inference jobs with cancellable loopback HTTP transport."""
import http.client
import json
import socket
import threading
import time

TIMEOUT_SECONDS = 180
TERMINAL = {'done', 'failed', 'cancelled'}


class InferenceError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


class Operation:
    def __init__(self, identifier, owner, timeout):
        self.id, self.owner = identifier, owner
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.created = time.monotonic()
        self.deadline = self.created + timeout
        self.finished = None
        self.stage = 'queued'
        self.transport = None
        self.result = {}
        self.partial = ''
        self.reason = 'CANCELLED'
        self.commit = None

    def check(self):
        if time.monotonic() >= self.deadline:
            self.stop('TIMEOUT')
        if self.cancel.is_set():
            code = self.reason
            raise InferenceError(code, '本機工作已逾時並停止。' if code == 'TIMEOUT' else '本機工作已取消。', 408 if code == 'TIMEOUT' else 409)

    def stop(self, reason='CANCELLED'):
        with self.lock:
            if self.stage in TERMINAL:
                return
            if not self.cancel.is_set():
                self.reason = reason
            self.cancel.set()
            self.stage = 'cancelling'
            transport = self.transport
        if transport:
            transport.cancel()

    def update(self, stage, text=None):
        with self.lock:
            self.check()
            self.stage = stage
            if text is not None:
                self.partial = text

    def public(self):
        with self.lock:
            return {'id':self.id, 'stage':self.stage,
                    'elapsedMs':round(((self.finished or time.monotonic())-self.created)*1000),
                    **({'text':self.partial} if self.partial else {}), **self.result}


class ModelStream:
    """Cancellation shuts down the socket; only the reading worker closes buffers."""
    def __init__(self, operation):
        self.operation = operation
        # A fixed numeric loopback destination; no environment proxy or redirect.
        self.connection = http.client.HTTPConnection('127.0.0.1', 11434, timeout=3)
        self.socket = self.response = None

    def cancel(self):
        sock = self.socket
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        try:
            if self.response is not None:
                self.response.close()
        finally:
            self.connection.close()

    def events(self, payload):
        op = self.operation
        try:
            op.check()
            self.connection.connect()
            self.socket = self.connection.sock
            op.check()
            self.connection.sock.settimeout(max(.1, op.deadline-time.monotonic()))
            self.connection.request('POST', '/api/chat', body=json.dumps(payload).encode(),
                                    headers={'Content-Type':'application/json'})
            response = self.connection.getresponse()
            self.response = response
            if response.status != 200:
                raise InferenceError('MODEL_UNAVAILABLE', '本機模型未能處理工作。', 503)
            while True:
                op.check()
                line = response.readline(200001)
                op.check()
                if not line:
                    break
                if len(line) > 200000:
                    raise ValueError('Oversized model record')
                if line.strip():
                    value = json.loads(line)
                    if not isinstance(value, dict) or value.get('error'):
                        raise ValueError('Invalid model record')
                    yield value
        except (OSError, ValueError, http.client.HTTPException) as error:
            op.check()
            raise InferenceError('MODEL_UNAVAILABLE', '本機模型連線中斷，工作尚未完成。', 503) from error


class InferenceJobs:
    def __init__(self, semaphore, timeout=TIMEOUT_SECONDS, capacity=256, active_limit=8, retention=60):
        self.semaphore, self.timeout = semaphore, timeout
        self.capacity, self.active_limit, self.retention = capacity, active_limit, retention
        self.lock = threading.RLock()
        self.jobs = {}

    def cleanup(self):
        with self.lock:
            self._prune()

    def close(self):
        with self.lock:
            for op in self.jobs.values():
                op.stop()

    def _prune(self):
        now = time.monotonic()
        for identifier, op in list(self.jobs.items()):
            if op.finished is not None and now-op.finished >= self.retention:
                del self.jobs[identifier]

    def _room(self):
        self._prune()
        if len(self.jobs) >= self.capacity:
            raise InferenceError('QUEUE_FULL', '本機工作數量已達上限，請稍後重試。', 429)

    def start(self, identifier, owner, work):
        with self.lock:
            self._room()
            existing = self.jobs.get(identifier)
            if existing:
                if existing.owner == owner and existing.stage == 'cancelled':
                    return existing.public()  # A cancellation may arrive before creation.
                raise InferenceError('REQUEST_EXISTS', '工作識別碼已使用，請重新開始。', 409)
            if sum(op.stage not in TERMINAL for op in self.jobs.values()) >= self.active_limit:
                raise InferenceError('QUEUE_FULL', '本機工作佇列已滿，請稍後重試。', 429)
            op = Operation(identifier, owner, self.timeout)
            self.jobs[identifier] = op
            threading.Thread(target=self._run, args=(op, work), daemon=True).start()
            return op.public()

    def get(self, identifier, owner):
        with self.lock:
            self._prune()
            op = self.jobs.get(identifier)
            if op is None or op.owner != owner:
                raise InferenceError('NOT_FOUND', '找不到此本機工作。', 404)
            return op.public()

    def cancel(self, identifier, owner):
        with self.lock:
            self._prune()
            op = self.jobs.get(identifier)
            if op is None:
                self._room()
                op = Operation(identifier, owner, self.timeout)
                op.stage, op.finished = 'cancelled', time.monotonic()
                self.jobs[identifier] = op
            elif op.owner != owner:
                raise InferenceError('NOT_FOUND', '找不到此本機工作。', 404)
            op.stop()
            return op.public()

    def _run(self, op, work):
        acquired = False
        timer = threading.Timer(self.timeout, lambda:op.stop('TIMEOUT'))
        timer.daemon = True
        timer.start()
        stage, result = 'failed', {}
        try:
            while True:
                op.check()
                if self.semaphore.acquire(timeout=.1):
                    acquired = True
                    break
            op.check()
            result = work(op)
            op.check()
            stage = 'done'
        except Exception as error:
            result = {'error':getattr(error, 'code', 'INFERENCE_FAILED'),
                      'message':str(error) if hasattr(error, 'code') else '本機工作失敗，請重試。'}
        finally:
            # Publish terminal state only after transport cleanup AND semaphore release.
            cleanup_failed = False
            try:
                if op.transport:
                    op.transport.close()
            except Exception:
                cleanup_failed = True
                stage, result = 'failed', {'error':'CLEANUP_FAILED','message':'模型連線清理失敗，請檢查助手狀態。'}
            finally:
                if acquired:
                    self.semaphore.release()
                with op.lock:
                    if op.cancel.is_set() and not cleanup_failed:
                        stage = 'failed' if op.reason == 'TIMEOUT' else 'cancelled'
                        result = {'error':op.reason, 'message':'本機工作已逾時並停止。' if op.reason == 'TIMEOUT' else '本機工作已取消。'}
                    elif stage == 'done' and op.commit:
                        try:
                            op.commit()
                        except Exception:
                            # Cache bookkeeping must not lose an otherwise valid result.
                            pass
                    op.stage, op.result, op.finished = stage, result, time.monotonic()
                    op.transport = None
                    op.commit = None
                timer.cancel()
