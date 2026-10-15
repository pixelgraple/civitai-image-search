<?php
declare(strict_types=1);

// Pure classifier regressions: no configuration, database, or image files required.
require dirname(__DIR__).'/lib.php';

// Surface PCRE warnings as failures instead of silently accepting missing cues.
set_error_handler(static function(int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) return false;
    throw new ErrorException($message, 0, $severity, $file, $line);
});

$checks = 0;
$failures = [];
function style_check(bool $condition, string $message): void {
    global $checks, $failures;
    $checks++;
    if (!$condition) $failures[] = $message;
}

// v7: two distinct affirmative art descriptors are required. These expected
// categories and cue IDs are specified independently, never derived from output.
// Fields: name, category, prompt, model, LoRAs, tags, expected canonical art cues.
$fixtures = [];
function style_fixture(string $name, string $category, string $prompt, string $model = '', array $loras = [], array $tags = [], array $cues = []): void {
    global $fixtures;
    $fixtures[] = [$name, $category, $prompt, $model, $loras, $tags, $cues];
}

$descriptiveCapturePrompt = 'An adult beside a window, individual hair strands catching ambient light. Directional lighting from front-left creates highlights and shadows. Camera angle is low, capturing a side-rear perspective. Facial expression drawing immediate attention. No discernible lens distortion or shallow depth of field; crisp throughout, suggesting a professional-grade setup. Controlled lighting and deliberate staging.';
$reportedCapturePrompt = 'An adult takes a smartphone selfie in a bright room. Her lips are painted with light pink lipstick. Freckles, natural skin texture, flyaway hair and warm indoor lighting are visible. She wears a white shirt and a necklace.';

foreach ([
    '', 'Portrait.', 'A blue cup on a wooden table.',
    'A photograph of an adult in a room.', 'An adult photographed in warm indoor light.',
    'Amateur smartphone selfie photography.', 'A photographic portrait.',
    'A photo of an adult outdoors.', 'Candid photos of people outdoors.',
    'Photographs of an adult in a room.', 'An adult photographing a garden.',
    'Portrait, photorealism.', 'DSLR portrait, detailed skin texture, visible pores.',
    'An adult taking a selfie.', 'A mirror selfie.',
    'A realistic portrait of an adult in a garden.', 'A realistic image of a mountain.',
    'A realistic scene of a quiet village.', 'A semi-realistic portrait of an adult.',
    'An adult with freckles and a white shirt in a warm room.',
    'A digital camera photograph of a mountain landscape.',
    'A digital clock beside a digital watch and digital display.',
    'Smooth rendering, realistic material textures and natural skin detail.',
    'An AI-generated image, artificial intelligence, AI photography.',
    'Masterpiece, best quality, absurdres, very aesthetic, very awa, score_9.',
    $reportedCapturePrompt, $descriptiveCapturePrompt,
] as $index => $prompt) {
    style_fixture('photographic or neutral input '.$index, 'realistic', $prompt);
}

// Every medium by itself stays below the threshold, regardless of its strength.
$singleCues = [
    ['anime', 'anime'], ['source_anime', 'anime'], ['ai-anime', 'anime'],
    ['japanese animation', 'anime'], ['manga', 'manga'], ['manhwa', 'manhwa'],
    ['manhua', 'manhua'], ['hentai', 'hentai'], ['cartoon', 'cartoon'],
    ['Pixar style', 'animation'], ['DreamWorks animation', 'animation'],
    ['digital illustration', 'illustration'], ['concept art', 'illustration'],
    ['pencil drawing', 'drawing'], ['hand-drawn', 'drawing'], ['drawn', 'drawing'],
    ['pencil sketch', 'sketch'], ['oil painting', 'painting'], ['watercolor', 'painting'],
    ['painted', 'painting'], ['digital art', 'digital-art'], ['digital', 'digital-art'],
    ['comic book art', 'comic'], ['comics style', 'comic'],
    ['cel-shaded', 'cel-shading'], ['toon shading', 'cel-shading'],
    ['line art', 'line-art'], ['thick black outlines', 'ink-outline'],
    ['flat colors', 'flat-color'], ['pixel art', 'pixel-art'], ['vector illustration', 'vector-art'],
    ['3D render', 'cgi'], ['CGI', 'cgi'], ['computer animation', 'cgi'],
    ['stylized', 'stylization'], ['non-photorealistic', 'stylization'],
    ['low-poly', 'low-poly'], ['voxel art', 'voxel'], ['claymation', 'clay-art'],
    ['paper cut art', 'paper-art'], ['woodcut', 'printmaking'], ['halftone', 'halftone'],
    ['crosshatching', 'hatching'], ['visual novel', 'game-art'], ['chibi', 'chibi'],
    ['fantasy', 'fantasy'], ['anthro', 'anthro'], ['source_furry', 'anthro'],
    ['furry', 'anthro'], ['waifu', 'anime-character'],
];
foreach ($singleCues as [$prompt, $cue]) {
    style_fixture('one cue stays realistic: '.$prompt, 'realistic', $prompt, '', [], [], [$cue]);
}

// Independent descriptors can come from the same field or different fields.
foreach ([
    ['anime and hentai', 'Anime, hentai.', ['anime','hentai']],
    ['anime and manga', 'Anime, manga.', ['anime','manga']],
    ['line art and cel shading', 'Line art, cel-shaded.', ['line-art','cel-shading']],
    ['drawing and cel shading', 'Hand-drawn, cel-shaded.', ['drawing','cel-shading']],
    ['source anime plus illustration', 'Source_anime, digital illustration.', ['anime','illustration']],
    ['illustration with outlines and flat colors', 'An illustration of a village, thick black outlines and flat colors.', ['illustration','ink-outline','flat-color']],
    ['comic and illustration', 'Comic art, digital illustration of a village.', ['comic','illustration']],
    ['anime plus photographic conflict', 'An actual photograph, anime illustration.', ['anime','illustration']],
    ['fantasy plus anthro', 'A fantasy scene with an anthropomorphic character.', ['fantasy','anthro']],
    ['cartoon plus pixel art', 'Cartoon, pixel art.', ['cartoon','pixel-art']],
    ['CG plus low poly', 'CGI, low-poly landscape.', ['cgi','low-poly']],
    ['paint plus hatched shading', 'Watercolor, crosshatching.', ['painting','hatching']],
    ['sketch plus line art', 'Pencil sketch, line art.', ['sketch','line-art']],
    ['vector plus halftone', 'Vector art, halftone.', ['vector-art','halftone']],
    ['paper art plus stylization', 'Papercut art, stylized.', ['paper-art','stylization']],
    ['positive weighted pair', '(anime, manga:0.5).', ['anime','manga']],
    ['contrast preserves positive art', 'Not anime but digital illustration, cel-shaded.', ['illustration','cel-shading']],
    ['art after photograph of shirt', 'A photograph of an adult wearing a shirt, comic book art style, cel-shaded.', ['comic','cel-shading']],
    ['animation after photograph of shirt', 'A photograph of an adult wearing a shirt, Pixar style, line art.', ['animation','line-art']],
] as [$name, $prompt, $cues]) {
    style_fixture($name, 'anime', $prompt, '', [], [], $cues);
}
style_fixture('prompt and model supply separate cues', 'anime', 'source_anime, photographic portrait.', 'Manga Model', [], [], ['anime','manga']);
style_fixture('prompt and LoRA supply separate cues', 'anime', 'source_anime, portrait.', '', ['Hentai Style'], [], ['anime','hentai']);
style_fixture('prompt and tag supply separate cues', 'anime', 'source_anime, portrait.', '', [], ['cel-shaded'], ['anime','cel-shading']);
style_fixture('separate metadata fields supply two cues', 'anime', 'Portrait.', 'Anime Model', ['Manga Style'], ['photography'], ['anime','manga']);
style_fixture('positive inline LoRA supplies distinct cues', 'anime', 'A photograph of a tree. <lora:AnimeHentai:0.5>', '', [], [], ['anime','hentai']);

// Repeated aliases and compound overlaps must not manufacture a second cue.
style_fixture('source anime with otherwise realistic prompt', 'realistic', 'source_anime, '.$reportedCapturePrompt, '', [], [], ['anime']);
style_fixture('source anime duplicated across every source', 'realistic', 'source_anime, anime, ai-anime.', 'Anime Model', ['Anime Style','SourceAnime'], ['anime','source_anime','ai-anime'], ['anime']);
style_fixture('digital illustration is one compound cue', 'realistic', 'Digital illustration.', '', [], [], ['illustration']);
style_fixture('compound plus shortened metadata keeps one cue', 'realistic', 'Digital illustration.', 'Illustration Model', ['Digital Illustration'], ['illustration'], ['illustration']);
style_fixture('toon and cel shading are aliases', 'realistic', 'Toon shading, cel shading, cell-shaded.', '', ['Cel Shading'], ['toon shading'], ['cel-shading']);
style_fixture('drawn variants are aliases', 'realistic', 'Hand-drawn, pencil drawing, drawing.', '', ['Digital Drawing'], ['drawn'], ['drawing']);
style_fixture('painting variants are aliases', 'realistic', 'Oil painting, watercolor, digital painting.', '', [], ['painting'], ['painting']);
style_fixture('anthro and furry aliases count once', 'realistic', 'Anthro, anthropomorphic, furry character.', '', [], ['source_furry'], ['anthro']);
style_fixture('single metadata cue is not doubled by its weight', 'realistic', 'Portrait.', 'Anime Model', [], [], ['anime']);
style_fixture('single LoRA cue is not doubled by its weight', 'realistic', 'Portrait.', '', ['Anime Style'], [], ['anime']);
style_fixture('camel case model cue alone remains one', 'realistic', 'A photograph of a tree.', 'SickAnime', [], [], ['anime']);
style_fixture('source anime plus quality tags stays one', 'realistic', 'source_anime, masterpiece, absurdres, best quality, score_9.', '', [], [], ['anime']);
style_fixture('anthro plus quality tags stays one', 'realistic', 'An anthro character, masterpiece, absurdres, very awa.', '', [], [], ['anthro']);
style_fixture('source anime plus generic AI stays one', 'realistic', 'source_anime, AI-generated photo, smooth rendering, realistic material textures.', '', [], [], ['anime']);
style_fixture('source anime plus photography stays one', 'realistic', 'source_anime, photographic, photo, photorealistic, selfie.', '', [], ['realistic'], ['anime']);
style_fixture('source anime plus realistic model stays one', 'realistic', 'source_anime, portrait.', 'SickRealism', ['RealismEngine'], ['realistic'], ['anime']);

// A wrong second cue is enough to cause the reported bug, so retain source_anime
// in these fixtures rather than allowing an exclusion bug to hide below threshold.
$nonStyleDescriptions = [
    'Her lips are painted with pink lipstick.',
    'An adult with painted nails beside a painted wall.',
    'The curtains are drawn.', 'Drawn curtains surround a window.',
    'A furry rug beside a furry blanket.', 'A furry dog beside a furry cat.',
    'An adult has an animated expression and an animated conversation.',
    'A 3D printer and 3D glasses are on the table.',
    'A red umbrella drawing immediate attention.',
    'A red umbrella drawing all attention to its color.',
    'An adult drawing fabric taut over a wooden frame.',
    'A red umbrella drawing the viewer’s eye toward the center.',
    "A red umbrella drawing the viewer's attention.",
    'A photograph of an anime poster on a wall.',
    'A photograph of an adult with cartoon stickers on a laptop.',
    'A photograph of an adult with a manga tattoo.',
    'A photograph of an adult wearing a comic art shirt.',
    'A photograph of an adult holding an anime-patterned case.',
    'A photograph of an adult wearing anime eyeliner.',
    'A photograph of a room with a framed digital illustration on the wall.',
    'A photograph of an adult wearing a shirt featuring a digital illustration.',
    'A photograph of a room with a canvas showing a digital illustration.',
    'A photograph of comic book art printed on a poster.',
    'A photograph of a painting on a wall.',
    'A photograph of a pencil drawing on a wall.',
    'A photograph of a fantasy poster on a wall.',
    'A photograph of an adult wearing a Pixar-style shirt.',
    'A photograph of an adult wearing a shirt with a Pixar logo.',
    'DreamWorks merchandise on a shelf.',
    'A digital camera, digital screen and digital watch.',
];
foreach ($nonStyleDescriptions as $index => $description) {
    style_fixture('object or idiom cannot become second cue '.$index, 'realistic', 'source_anime, '.$description, '', [], [], ['anime']);
}
foreach (['painted nails','drawn curtains','furry rug','furry dog','animated expression','3D printer','digital camera'] as $description) {
    style_fixture('ambiguous metadata tag: '.$description, 'realistic', 'source_anime, portrait.', '', [], [$description], ['anime']);
    style_fixture('ambiguous model: '.$description, 'realistic', 'source_anime, portrait.', $description, [], [], ['anime']);
    style_fixture('ambiguous LoRA: '.$description, 'realistic', 'source_anime, portrait.', '', [$description], [], ['anime']);
}

// Negated and disabled groups cannot cross the threshold, including new words.
foreach ([
    'No anime or cartoon.', 'Not a digital illustration.',
    'No digital illustration or comic art.', 'Not comic art or digital illustration.',
    'Remove any tags containing anime or illustration.', 'No fantasy or anime.',
    'No drawing or painting or CGI.', 'No vector or sketch.',
    'Without cel-shading or anime.', 'Avoid low-poly or voxel art.',
    'Not manga or hentai.', 'No stylized or cartoon rendering.',
    '(anime, cartoon, illustration:-1).', '(anime, cartoon, illustration:-1.5).',
    '(anime, cartoon, illustration:-.5).', '(anime, cartoon, illustration:0).',
    '(anime, cartoon, illustration:0.000).',
    '((anime:1.5), cartoon:0).', '((anime:1.5), illustration:-0.5).',
    '((anime:0):1.5).', '(digital illustration, thick outlines, flat colors:0).',
    '(digital illustration, comic book art:-1).',
    '<lora:AnimeHentai:0>', '<lora:AnimeHentai:0.000>',
    '<lora:AnimeHentai:-1>', '<lora:AnimeHentai:-.5>',
] as $index => $exclusion) {
    style_fixture('excluded cues alone '.$index, 'realistic', $exclusion);
    style_fixture('excluded cues cannot supplement source anime '.$index, 'realistic', 'source_anime, '.$exclusion, '', [], [], ['anime']);
}
style_fixture('negated model cue is excluded', 'realistic', 'source_anime.', 'No manga', [], [], ['anime']);
style_fixture('negated LoRA cue is excluded', 'realistic', 'source_anime.', '', ['No hentai'], [], ['anime']);
style_fixture('negated tag cue is excluded', 'realistic', 'source_anime.', '', [], ['no illustration'], ['anime']);
style_fixture('disabled outer group removes positive inline resource', 'realistic', 'source_anime, (<lora:MangaStyle:1>:0).', '', [], [], ['anime']);
style_fixture('positive fractional single cue still stays one', 'realistic', '(anime:0.5).', '', [], [], ['anime']);
style_fixture('positive inline single cue still stays one', 'realistic', '<lora:AnimeName:0.5>', '', [], [], ['anime']);
style_fixture('disabled group cannot suppress separate positive pair', 'anime', '((cartoon:1.2):0), anime illustration.', '', [], [], ['anime','illustration']);
style_fixture('photo object metadata supplies no art evidence', 'realistic', 'source_anime.', '', [], ['photo (object)','photo background'], ['anime']);

// v8: neutral descriptions reproduce the metadata failures in reported records.
style_fixture('reported lake photograph 145674491', 'realistic', 'Analog amateur photograph of an adult swimming in a lake.', 'Krea 2 CyberRealistic', ['Girly Plus Size Fantasy'], ['3d','realistic','photorealistic'], ['fantasy']);
style_fixture('reported negation 145634454', 'realistic', 'Ultra-photorealistic cinematic portrait, realistic skin texture, no artificial filters or stylization.', 'Krea2 - DarkRealism', ['Krea2 Ultra Realism'], ['3d','realistic']);
$disabledAnimeResource = 'DC_Fractured_Anime__Krea2Raw__GPT4_1Captioned__Trigger_DCFRCANMA___Rank32__v1_krea2_3325529_epoch_12';
$reportedResources = '<lora:realism_engine_krea2_v2:0.9> <lora:'.$disabledAnimeResource.':0> <lora:Mrpopo anime full potential:0>';
style_fixture('reported commercial photograph 145590806', 'realistic', 'The overall style is deliberate and stylized, typical of commercial photography, with careful composition. '.$reportedResources, 'Krea 2 Turbo', [$disabledAnimeResource,'Mrpopo anime full potential','Realism Engine'], ['3d','photorealistic','photography']);
style_fixture('reported posed photograph 145590804', 'realistic', 'An adult seated on a red lounge chair. Camera angle slightly elevated, soft ambient light, controlled depth of field. '.$reportedResources, 'Krea 2 Turbo', [$disabledAnimeResource,'Mrpopo anime full potential','Realism Engine'], ['3d','photorealistic','photography']);
foreach (['0','0.000','-0','+0','.0','0e0','0e-3','-1','-.5'] as $weight) {
    style_fixture('disabled metadata cannot resurrect '.$weight, 'realistic', 'source_anime. <lora:MangaStyle:'.$weight.'>', '', ['MangaStyle'], [], ['anime']);
    style_fixture('disabled full resource metadata '.$weight, 'realistic', 'source_anime.', '', ['<lora:MangaStyle:'.$weight.'>'], [], ['anime']);
}
style_fixture('disabled metadata filename display alias', 'realistic', 'Photograph. <lora:Anime_Hentai_Model:0>', '', ['ANIME HENTAI MODEL.safetensors']);
style_fixture('disabled LyCORIS metadata', 'realistic', 'Photograph. <lyco:AnimeHentai:0>', '', ['AnimeHentai']);
style_fixture('outer disabled group excludes duplicate resource metadata', 'realistic', 'source_anime. (<lora:MangaStyle:1>:0)', '', ['MangaStyle'], [], ['anime']);
style_fixture('active resource after disabled duplicate remains evidence', 'anime', '<lora:AnimeHentai:0> <lora:AnimeHentai:0.5>', '', ['AnimeHentai'], [], ['anime','hentai']);
style_fixture('disabled duplicate after active resource stays active', 'anime', '<lora:AnimeHentai:0.5> <lora:AnimeHentai:0>', '', ['AnimeHentai'], [], ['anime','hentai']);
style_fixture('positive exponent resource remains active', 'anime', '<lora:AnimeHentai:1e-2>', '', [], [], ['anime','hentai']);
style_fixture('zero dual resource weights are disabled', 'realistic', '<lora:AnimeHentai:0:0>', '', ['AnimeHentai']);
style_fixture('one positive dual resource weight remains active', 'anime', '<lora:AnimeHentai:0:0.5>', '', ['AnimeHentai'], [], ['anime','hentai']);
style_fixture('disabled resource does not suppress unrelated active name', 'anime', '<lora:AnimeHentai:0>', '', ['AnimeHentaiPlus'], [], ['anime','hentai']);
style_fixture('disabled resource does not negate explicit prompt art', 'anime', 'Anime illustration. <lora:AnimeHentai:0>', '', ['AnimeHentai'], [], ['anime','illustration']);
style_fixture('generic 3d tag cannot supplement source anime', 'realistic', 'source_anime, photograph.', '', [], ['3d','source_3d','3-d'], ['anime']);
style_fixture('explicit rendering tag remains valid', 'anime', 'source_anime.', '', [], ['3D render'], ['anime','cgi']);
style_fixture('explicit rendering prompt remains valid', 'anime', '3D render, cartoon landscape.', '', [], ['3d'], ['cgi','cartoon']);
style_fixture('negated filters cannot supply second cue', 'realistic', 'source_anime, no artificial filters or stylization.', '', [], [], ['anime']);
style_fixture('negation does not swallow new positive sentence', 'anime', 'No artificial filters. Anime illustration.', '', [], [], ['anime','illustration']);
style_fixture('commercial photographic styling is not art medium', 'realistic', 'source_anime. Stylized commercial photography.', '', [], [], ['anime']);
style_fixture('photographic adjective does not erase explicit illustration', 'anime', 'A stylized photographic illustration.', '', [], [], ['stylization','illustration']);

foreach ($fixtures as [$name,$expected,$prompt,$model,$loras,$tags,$expectedCues]) {
    try {
        $actual = classify_style($prompt,$model,$loras,$tags);
        $actualCues = $actual['evidence']['animeCues'] ?? null;
        style_check(($actual['category'] ?? null) === $expected, $name.': expected '.$expected.', got '.($actual['category'] ?? 'missing'));
        style_check(is_numeric($actual['confidence'] ?? null) && $actual['confidence'] >= 0 && $actual['confidence'] <= 1, $name.': confidence must be between 0 and 1');
        style_check(is_array($actual['signals'] ?? null) && is_array($actual['scores'] ?? null), $name.': signals and scores must be present');
        style_check(($actual['version'] ?? null) === 8, $name.': classifier evidence must identify version 8');
        style_check(in_array($actual['category'] ?? null, ['anime','realistic'], true), $name.': binary policy must not return uncertain');
        style_check(($actual['evidence']['animeCueMinimum'] ?? null) === 2, $name.': evidence must declare the two-cue threshold');
        style_check(($actual['evidence']['animeCueCount'] ?? null) === count($expectedCues), $name.': incorrect distinct cue count; expected '.count($expectedCues).', got '.($actual['evidence']['animeCueCount'] ?? 'missing'));
        if (is_array($actualCues)) sort($actualCues);
        sort($expectedCues);
        style_check($actualCues === $expectedCues, $name.': expected cues '.json_encode($expectedCues).', got '.json_encode($actualCues));
        style_check(is_array($actualCues) && count($actualCues) === count(array_unique($actualCues)), $name.': canonical cue identifiers must be unique');
        $policySignals = array_filter($actual['signals'] ?? [], static fn(array $signal): bool => ($signal['source'] ?? '') === 'policy' && ($signal['rule'] ?? '') === 'two-cue realistic default');
        style_check(count($policySignals) === ($expected === 'realistic' ? 1 : 0), $name.': fallback policy explanation must agree with the decision');
    } catch (Throwable $error) {
        style_check(false, $name.': threw '.$error->getMessage());
    }
}

foreach (['anime','source_anime','digital illustration','toon shading','photorealistic','photography'] as $term) {
    $single = classify_style($term,'',[],[]);
    $repeated = classify_style(implode(', ',array_fill(0,20,$term)),'',[],[]);
    style_check($single['category'] === $repeated['category'], $term.': repetition must not change category');
    style_check($single['scores'] === $repeated['scores'], $term.': repetition must not inflate scores');
    style_check($single['confidence'] === $repeated['confidence'], $term.': repetition must not inflate confidence');
    style_check($single['evidence'] === $repeated['evidence'], $term.': repetition must not inflate distinct cues');
}

$descriptiveStyle = classify_style($descriptiveCapturePrompt,'',[],[]);
style_check(!array_filter($descriptiveStyle['signals'] ?? [], static fn(array $signal): bool => ($signal['rule'] ?? '') === 'lens detail'), 'negated shallow depth of field must not supply lens evidence');
foreach (['', 'Portrait.', 'Masterpiece, best quality, absurdres.', '(anime, fantasy, digital:0).', 'source_anime'] as $defaultPrompt) {
    $defaultStyle = classify_style($defaultPrompt,'',[],[]);
    style_check($defaultStyle['category'] === 'realistic', 'fewer than two art cues must default to realistic');
    style_check($defaultStyle['confidence'] > 0 && $defaultStyle['confidence'] <= 0.6, 'default without explicit photo evidence must retain modest confidence');
}
$mixedStyle = classify_style('An actual photograph, anime illustration.','',[],[]);
style_check($mixedStyle['category'] === 'anime', 'two affirmative cues retain the selected Anime sorting policy');
style_check($mixedStyle['scores']['anime'] > 0 && $mixedStyle['scores']['realistic'] > 0, 'mixed decisions must retain conflicting photographic evidence');

echo json_encode(['ok'=>!$failures,'checks'=>$checks,'fixtures'=>count($fixtures),'suite'=>'style-classification','failures'=>$failures], JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE).PHP_EOL;
exit($failures ? 1 : 0);
