import copy
from pathlib import Path
import tempfile
import unittest
from evaluate_translation import load_corpus, imported_results, make_run, report, write_new, review_warnings, RUBRIC


class QualityTest(unittest.TestCase):
    def setUp(self):
        self.corpus, self.digest = load_corpus()
        self.translations = {case['id']: '人工譯文 120 30 GET /api/show message.content local:test 6000' for case in self.corpus['cases']}

    def test_import_rejects_missing_extra_empty_or_partial_results(self):
        for change in ('missing', 'extra', 'empty'):
            values = dict(self.translations)
            if change == 'missing': values.pop(next(iter(values)))
            if change == 'extra': values['unknown'] = '譯文'
            if change == 'empty': values[next(iter(values))] = ' '
            with self.assertRaises(ValueError): imported_results(self.corpus, values)

    def test_unreviewed_outputs_never_become_passing_quality_scores(self):
        run = make_run(self.corpus, self.digest, 'test-engine', imported_results(self.corpus, self.translations))
        for case in run['cases']:
            self.assertTrue(all(case['review'][name] is None for name in RUBRIC))
            self.assertIsNone(case['seconds'])
        text, key = report(self.corpus, self.digest, [run])
        self.assertIn('0/12', text)
        self.assertIn('待評', text)
        self.assertNotIn('test-engine', text)
        self.assertEqual(key['A']['system'], 'test-engine')

    def test_mismatched_corpus_duplicates_and_invalid_scores_cannot_be_compared(self):
        run = make_run(self.corpus, self.digest, 'test', imported_results(self.corpus, self.translations))
        for mutation in ('digest', 'duplicate', 'score'):
            changed = copy.deepcopy(run)
            if mutation == 'digest': changed['corpusSha256'] = 'wrong'
            if mutation == 'duplicate': changed['cases'][0]['id'] = changed['cases'][1]['id']
            if mutation == 'score': changed['cases'][0]['review'][RUBRIC[0]] = True
            with self.assertRaises(ValueError): report(self.corpus, self.digest, [changed])

    def test_existing_results_and_human_reviews_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'result.json'
            write_new(file, 'original review')
            with self.assertRaises(FileExistsError): write_new(file, 'replacement')
            self.assertEqual(file.read_text(), 'original review')

    def test_untranslated_and_mixed_japanese_are_review_signals_without_auto_scoring(self):
        self.assertTrue(review_warnings('El resumen incluye texto.', 'El resumen incluye texto.'))
        self.assertTrue(review_warnings('設定を変更', '設定を変更後，資料保留。'))
        self.assertEqual(review_warnings('Keep the backup.', '保留備份。'), [])
