"""Model-response boundaries; no Ollama, model download, or real user data."""
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from app import Companion, UserError


class ModelOutputTest(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).resolve().parents[1] / 'test-results'
        base.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=base)
        self.response = {'message': {'content': '有效譯文'}}
        self.events = []

        def request(route, payload=None, timeout=None):
            if route == '/api/tags':
                return {'models': [{'name': 'local:test'}]}
            if route == '/api/show':
                return {}
            return self.response

        self.app = Companion(self.directory.name, request, lambda payload: (event for event in self.events))
        self.app.config['model'] = 'local:test'
        self.app.converter = SimpleNamespace(convert=lambda text: text)

    def tearDown(self):
        self.directory.cleanup()

    def assert_released(self):
        acquired = self.app.inference.acquire(blocking=False)
        self.assertTrue(acquired, 'A failed request must not block the next translation')
        if acquired:
            self.app.inference.release()

    def test_unclosed_thinking_is_rejected_in_translation_and_json_summary(self):
        self.response = {'message': {'content': '可見文字<think>private reasoning'}}
        for operation in (self.app.translate, self.app.summarize):
            with self.subTest(operation=operation.__name__):
                with self.assertRaises(UserError) as caught:
                    operation('人工原文')
                self.assertEqual(caught.exception.code, 'MODEL_INCOMPLETE')
                self.assertNotIn('private reasoning', str(caught.exception))
                self.assert_released()

    def test_unclosed_thinking_at_stream_completion_is_not_cached(self):
        self.events = [
            {'message': {'content': '可見文字<thi'}},
            {'message': {'content': 'nk>private reasoning'}, 'done': True},
        ]
        received = []
        with self.assertRaises(UserError) as caught:
            for event in self.app.stream_summary('人工原文'):
                received.append(event)
        self.assertEqual(caught.exception.code, 'MODEL_INCOMPLETE')
        self.assertFalse(any(event.get('done') for event in received))
        self.assertNotIn('private reasoning', str(received))
        self.assertFalse(self.app.summary_cache)
        self.assert_released()

    def test_completed_stream_preserves_literal_angle_bracket_suffixes(self):
        for suffix in ('<', '<t', '<thi'):
            with self.subTest(suffix=suffix):
                expected = '範例字串：' + suffix
                self.events = [{'message': {'content': expected}}, {'done': True}]
                result = list(self.app.stream_summary('人工原文' + suffix))[-1]
                self.assertEqual(result['text'], expected)
                self.assertEqual(list(self.app.stream_summary('人工原文' + suffix))[-1]['text'], expected)

    def test_complete_thinking_blocks_are_removed_without_losing_answer(self):
        raw = '<think>first\nthought</think>保留<think>second thought</think>答案'
        self.response = {'message': {'content': raw}}
        self.assertEqual(self.app.translate('人工原文')['text'], '保留答案')
        self.events = [{'message': {'content': character}} for character in raw]
        self.events.append({'done': True})
        events = list(self.app.stream_summary('人工原文'))
        self.assertEqual(events[-1]['text'], '保留答案')
        self.assertFalse(any('thought' in event.get('text', '') for event in events))

    def test_malformed_chat_outputs_report_model_error_and_release_lock(self):
        for value in (None, [], {'message': None}, {'message': []},
                      {'message': {'content': None}}, {'message': {'content': 42}}):
            with self.subTest(value=value):
                self.response = value
                with self.assertRaises(UserError) as caught:
                    self.app.translate('人工原文')
                self.assertEqual(caught.exception.code, 'MODEL_OUTPUT')
                self.assert_released()

    def test_malformed_stream_outputs_report_model_error_and_release_lock(self):
        for value in (None, [], {'message': None}, {'message': {'content': 42}}):
            with self.subTest(value=value):
                self.events = [value]
                with self.assertRaises(UserError) as caught:
                    list(self.app.stream_summary('人工原文'))
                self.assertEqual(caught.exception.code, 'MODEL_OUTPUT')
                self.assertFalse(self.app.summary_cache)
                self.assert_released()

    def test_empty_and_truncated_chat_outputs_never_become_success(self):
        for response, code in (({'message': {'content': '<think>only thoughts</think>'}}, 'MODEL_OUTPUT'),
                               ({'message': {'content': '部分譯文'}, 'done_reason': 'length'}, 'MODEL_TRUNCATED')):
            with self.subTest(code=code):
                self.response = response
                with self.assertRaises(UserError) as caught:
                    self.app.translate('人工原文')
                self.assertEqual(caught.exception.code, code)
                self.assert_released()


if __name__ == '__main__':
    unittest.main()
