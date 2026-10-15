import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
PHP = os.environ.get('PHP_BINARY', 'php')
checks = 0


def check(value, label):
    global checks
    if not value:
        raise AssertionError(label)
    checks += 1


with tempfile.TemporaryDirectory(prefix='civitai-reclass-') as temporary:
    temp = pathlib.Path(temporary)
    database, config = temp / 'catalog.sqlite', temp / 'config.php'
    config.write_text("<?php return ['database_path'=>" + json.dumps(str(database)) + "];")
    db = sqlite3.connect(database)
    db.row_factory = sqlite3.Row
    db.executescript((root / 'schema.sql').read_text())
    fixtures = [
        ('91', 'amateur smartphone selfie photography, natural skin tones', 'uncertain', 'ready', 1, ''),
        ('92', 'anime illustration with cel shading', 'realistic', 'pending', 2, 'Thumbnail needs local repair.'),
        ('93', 'a person wearing a blue jacket', 'uncertain', 'failed', 5, 'Synthetic previous source failure.'),
    ]
    for index, (ident, prompt, style, download_status, attempts, error) in enumerate(fixtures):
        tags, loras = ['fixturetag', 'catalogfixture'], ['Neutral adapter']
        # Art words in the negative prompt remain searchable metadata but are
        # deliberately excluded from the positive style classifier inputs.
        negative, model = 'fixtureexcluded, unwanted artifacts, anime, fantasy, digital art', 'Base checkpoint'
        row = {
            'image_id': ident,
            'source_url': 'https://image.civitai.com/key/test/original=true/' + ident + '.png',
            'file_path': 'ab/' + ident + '.png',
            'mime_type': 'image/png',
            'file_size': 2048 + index,
            'sha256': hashlib.sha256(('synthetic media ' + ident).encode()).hexdigest(),
            'prompt': prompt,
            'negative_prompt': negative,
            'tags_json': json.dumps(tags),
            'model_name': model,
            'loras_json': json.dumps(loras),
            'reactions_json': json.dumps({'likeCount': 17 + index, 'heartCount': 4, 'buzzCount': 23}),
            'image_width': 768 + index,
            'image_height': 1024 + index,
            'style_category': style,
            'download_status': download_status,
            'download_attempts': attempts,
            'download_error': error,
            'discovered_at': '2026-01-01T12:34:56Z',
            'updated_at': '2026-01-02T23:45:01Z',
        }
        db.execute('INSERT INTO images(' + ','.join(row) + ') VALUES(' + ','.join('?' for _ in row) + ')', tuple(row.values()))
        db.execute('INSERT INTO images_fts(image_id,prompt,negative_prompt,tags,model_name,lora_names) VALUES(?,?,?,?,?,?)',
                   (ident, prompt, negative, ' '.join(tags), model, ' '.join(loras)))
    for ident, visitor, reaction in [('91', 'a', 'upvote'), ('91', 'b', 'upvote'), ('91', 'a', 'heart'),
                                      ('92', 'c', 'laugh'), ('93', 'd', 'wow')]:
        db.execute('INSERT INTO community_reactions(image_id,visitor_hash,reaction_type,created_at) VALUES(?,?,?,?)',
                   (ident, visitor * 64, reaction, 1767225600))
    db.commit()

    def rows(query):
        return [dict(row) for row in db.execute(query)]

    def invariant():
        images = rows('SELECT * FROM images ORDER BY image_id')
        for image in images:
            for key in ('style_category', 'style_confidence', 'style_signals_json'):
                image.pop(key)
        return {
            'images': images,
            'fts': rows('SELECT * FROM images_fts ORDER BY image_id'),
            'communityVotes': rows('SELECT * FROM community_reactions ORDER BY image_id,visitor_hash,reaction_type'),
            'communityCounts': rows('SELECT * FROM community_reaction_counts ORDER BY image_id'),
        }

    def categories():
        return {row['image_id']: row['style_category'] for row in db.execute('SELECT image_id,style_category FROM images')}

    original = invariant()
    original_images = rows('SELECT * FROM images ORDER BY image_id')
    check({row['download_status'] for row in original['images']} == {'ready', 'pending', 'failed'}, 'fixture covers every download state')
    check(len(original['communityVotes']) == 5 and original['communityCounts'][0]['upvote'] == 2, 'fixture contains real vote rows and trigger-maintained counts')
    env = dict(os.environ, CIVITAI_LIBRARY_CONFIG=str(config))

    def run(*args):
        return json.loads(subprocess.check_output([PHP, str(root / 'reclassify.php'), *args], env=env, timeout=30))

    dry = run()
    check(not dry['applied'] and dry['changedCategories'] == 3, 'binary-policy dry run previews two explicit styles and one realistic default')
    check(categories() == {'91': 'uncertain', '92': 'realistic', '93': 'uncertain'}, 'dry run changes no categories')
    check(rows('SELECT * FROM images ORDER BY image_id') == original_images, 'dry run changes no image fields, including style metadata')
    check(invariant() == original, 'dry run preserves FTS and community data')

    applied = run('--apply')
    check(applied['applied'] and applied['changedCategories'] == 3, 'binary-policy apply changes exactly the three intended categories')
    check(categories() == {'91': 'realistic', '92': 'anime', '93': 'realistic'}, 'binary policy supplies realistic fallback while ignoring negative-prompt art words')
    preserved = invariant()
    check(preserved['images'] == original['images'], 'all prompts, media paths, hashes, sizes, source reactions, timestamps and download states preserved')
    check(preserved['fts'] == original['fts'], 'every FTS field preserved')
    check(preserved['communityVotes'] == original['communityVotes'], 'community vote identities, types and timestamps preserved')
    check(preserved['communityCounts'] == original['communityCounts'], 'community reaction totals preserved')
    check(dry['nonStyleFieldsSha256'] == applied['nonStyleFieldsSha256'], 'dry-run and apply non-style digests agree')
    check(db.execute("SELECT COUNT(*) FROM images WHERE style_signals_json!='[]'").fetchone()[0] == 3, 'evidence stored for explicit classifications and realistic fallback')
    fallback = db.execute("SELECT style_confidence,style_signals_json FROM images WHERE image_id='93'").fetchone()
    fallback_signals = json.loads(fallback['style_signals_json'])
    check(sum(signal.get('category') == 'realistic' and signal.get('source') == 'policy'
              and signal.get('rule') == 'realistic default' for signal in fallback_signals) == 1,
          'realistic fallback policy signal is persisted exactly once')
    check(0 < fallback['style_confidence'] <= 0.6, 'realistic default stores modest confidence')
    check(not any(signal.get('category') == 'anime' for signal in fallback_signals),
          'negative-prompt art words never become affirmative anime evidence')

    again = run('--apply')
    check(again['changedCategories'] == 0 and again['updatedStyleMetadata'] == 0, 'reclassification is idempotent')
    check(invariant() == original, 'idempotent apply preserves all non-style data')
    check(again['nonStyleFieldsSha256'] == applied['nonStyleFieldsSha256'], 'idempotent apply preserves non-style digest')

    # A scoped backfill must leave an existing classification untouched even if
    # a full refresh would correct it. Non-style content stays the same fixture.
    db.execute("UPDATE images SET style_category='uncertain',style_confidence=0,style_signals_json='[]' WHERE image_id='91'")
    db.execute("UPDATE images SET style_category='realistic',style_confidence=0.123,style_signals_json=? WHERE image_id='92'",
               (json.dumps([{'fixture': 'outside requested scope'}]),))
    db.commit()
    scoped_before = rows('SELECT * FROM images ORDER BY image_id')
    outside_scope = rows("SELECT * FROM images WHERE image_id='92'")
    scoped_dry = run('--uncertain-only')
    check(not scoped_dry['applied'] and scoped_dry['changedCategories'] == 1, 'uncertain-only dry run previews only the uncertain correction')
    check(rows('SELECT * FROM images ORDER BY image_id') == scoped_before, 'uncertain-only dry run leaves every image field unchanged')
    check(invariant() == original, 'uncertain-only dry run preserves non-style fields, FTS and votes')

    scoped_apply = run('--uncertain-only', '--apply')
    check(scoped_apply['applied'] and scoped_apply['changedCategories'] == 1, 'uncertain-only apply changes exactly one category')
    check(categories() == {'91': 'realistic', '92': 'realistic', '93': 'realistic'}, 'uncertain-only apply leaves existing classifications outside scope')
    check(rows("SELECT * FROM images WHERE image_id='92'") == outside_scope, 'out-of-scope confidence and evidence are also untouched')
    check(invariant() == original, 'uncertain-only apply preserves all non-style data and community reactions')
    check(scoped_dry['nonStyleFieldsSha256'] == scoped_apply['nonStyleFieldsSha256'], 'scoped dry-run and apply non-style digests agree')
    scoped_again = run('--uncertain-only', '--apply')
    check(scoped_again['changedCategories'] == 0 and scoped_again['updatedStyleMetadata'] == 0, 'uncertain-only reclassification is idempotent')
    check(rows("SELECT * FROM images WHERE image_id='92'") == outside_scope and invariant() == original,
          'repeated scoped apply preserves excluded style data and every non-style field')
    check(db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'catalog integrity preserved')
    check(not db.execute('PRAGMA foreign_key_check').fetchall(), 'community image references remain valid')
    db.close()

print(json.dumps({'ok': True, 'suite': 'reclassification', 'checks': checks, 'productionTouched': False}))
