<?php
declare(strict_types=1);
const CIVITAI_STYLE_CLASSIFIER_VERSION = 9;
const CIVITAI_STYLE_ANIME_MINIMUM_CUES = 2;

/** Library sorting policy, not visual inspection or a statistical probability. */
function classify_prompt_style(string $prompt, string $model, array $loras, array $tags): array {
    $lightingPattern = '(?:controlled|studio|directional) lighting|lighting is directional|(?:professional[ -]grade|studio) (?:lighting )?setup';
    // Each rule represents one distinct descriptor. Spelling variants and
    // source_anime/ai-anime share Anime; anime, manga and hentai are distinct.
    // The longest overlapping phrase wins: digital illustration is one cue,
    // never both "digital" and "illustration". Quality scores and AI alone
    // describe neither an illustrated medium nor a photographic one.
    $artRules = [
        ['anime', 'anime medium', '(?:(?:source|ai)[ -]+)?anime(?:sque)?|japanimation|japanese[ -]animation', 6],
        ['manga', 'manga medium', '(?:source[ -]+)?manga', 6],
        ['manhwa', 'manhwa medium', 'manhwa|webtoon', 6],
        ['manhua', 'manhua medium', 'manhua', 6],
        ['hentai', 'hentai medium', '(?:source[ -]+)?hentai', 6],
        ['ecchi', 'ecchi style', '(?:source[ -]+)?ecchi', 3],
        ['cartoon', 'cartoon medium', '(?:source[ -]+)?cartoons?|cartoonish|cartoony|toon(?:[ -](?:art|style))?', 6],
        ['animation', 'animation medium', '(?:2[ -]?d[ -]+)?animat(?:ion|ed)(?:[ -]+(?:film|movie|style))?|(?:pixar|dream[ -]?works|disney|ghibli|illumination)(?:[ -](?:inspired|like))?(?:[ -](?:3[ -]?d|animated|animation|cartoon))?[ -](?:style|animation|animated(?: film)?|look|aesthetic)', 6],
        ['illustration', 'illustrated medium', '(?:(?:digital|editorial|book|fashion|children[’\x27]s)[ -]+)?illustrat(?:ion|ions|ed)(?:[ -]style)?|concept[ -]art|key[ -]visual', 6],
        ['drawing', 'drawn medium', '(?:(?:digital|pencil|charcoal|graphite|ink|hand)[ -]+)?draw(?:ing|ings|n)|hand[ -]drawn', 6],
        ['sketch', 'sketched medium', '(?:(?:pencil|charcoal|graphite|ink|digital)[ -]+)?sketch(?:es|ed|ing)?|sketchbook[ -]art', 6],
        ['painting', 'painted medium', '(?:(?:digital|oil|acrylic|gouache|tempera|pastel|watercolou?r|matte|ink|hand)[ -]+)?paint(?:ing|ings|ed)|watercolou?rs?|gouache|impasto|fresco|sumi[ -]e|en[ -]plein[ -]air', 6],
        ['digital-art', 'digital art style', 'digital(?:[ -]+(?:art(?:work)?|style)|(?=\s*(?:[,;|):\]]|\.(?:\s|$)|$)))', 6],
        ['comic', 'comic medium', '(?:source[ -]+)?comics?(?:[ -]book)?(?:[ -](?:art|illustration|style))?(?:[ -]style)?|graphic[ -]novel|bande[ -]dessin[eé]e', 6],
        ['cel-shading', 'cel shading', 'cel[ -]shad(?:ed|ing)|cell[ -]shad(?:ed|ing)|toon[ -]shad(?:ed|ing)', 5],
        ['line-art', 'line art', 'line[ -]?art|line[ -]drawing|contour[ -]drawing', 5],
        ['ink-outline', 'inked outlines', '(?:thick|bold|heavy|clean|inked)[ -]+(?:black[ -]+)?outlines?|inked[ -]lines|inking', 3],
        ['flat-color', 'flat colors', 'flat[ -]colou?rs?|flat[ -]shad(?:ed|ing)|solid[ -]colou?r[ -]fills?', 3],
        ['motion-lines', 'drawn motion lines', '(?:motion|speed|action)[ -]lines', 3],
        ['pixel-art', 'pixel art', 'pixel[ -]art|pixelated[ -]art|pixel[ -]sprites?|sprite[ -]art|(?:8|16|32)[ -]bit[ -](?:art|style|graphics)', 6],
        ['vector-art', 'vector art', 'vector(?:[ -](?:art|illustration|drawing|graphics))?|(?:svg|eps)[ -](?:art|illustration)', 6],
        ['cgi', 'CG rendering', '(?:3[ -]?d|computer)[ -]animat(?:ed|ion)(?:[ -]film)?|(?:3[ -]?d|cg|cgi|computer[ -]generated)(?:[ -](?:art(?:work)?|imagery|graphics|render(?:ing)?|illustration|model(?:ing)?))?|(?:ray|path)[ -]traced[ -]render(?:ing)?|(?:octane|redshift|blender|cinema[ -]4d|unreal[ -]engine|daz[ -](?:studio|3d)|poser)[ -](?:render(?:ing)?|art)|zbrush[ -]sculpt', 6],
        ['stylization', 'stylized rendering', 'styliz(?:ed|ation)|stylis(?:ed|ation)|non[ -]photo[ -]?realis(?:tic|m)|non[ -]realistic|non[ -]photographic|npr[ -]render(?:ing)?', 3],
        ['low-poly', 'low polygon art', 'low[ -]poly(?:gon)?|polygonal[ -]art|faceted[ -]render(?:ing)?', 5],
        ['voxel', 'voxel art', 'voxel(?:[ -](?:art|render(?:ing)?|style))?', 5],
        ['clay-art', 'clay animation', 'claymation|clay[ -](?:animation|render(?:ing)?|art[ -]style)|plasticine[ -]style|stop[ -]motion', 5],
        ['paper-art', 'paper art', 'paper[ -]cut(?:out)?[ -](?:art|style)|papercut[ -](?:art|style)|cut[ -]paper[ -]art|origami[ -](?:art|style)', 5],
        ['printmaking', 'printmaking medium', 'woodcut|linocut|lithograph(?:y|ic)?|engraving|etching|screen[ -]print[ -]art|risograph(?:y)?|ukiyo[ -]e', 5],
        ['halftone', 'halftone shading', 'halftone(?:[ -](?:dots|shading|style))?|ben[ -]day[ -]dots|screentone', 3],
        ['hatching', 'hatched shading', 'cross[ -]?hatch(?:ed|ing)|hatched[ -]shading|stippl(?:ed|ing)', 3],
        ['game-art', 'video game art', '(?:video[ -]game|game)[ -](?:art|render(?:ing)?|graphics|screenshot)|visual[ -]novel(?:[ -](?:art|style))?|jrpg[ -](?:art|style)', 5],
        ['chibi', 'chibi proportions', 'chibi|super[ -]deformed', 3],
        ['fantasy', 'fantasy style', 'fantasy|fantastical', 2],
        ['anthro', 'anthro character', '(?:source[ -]+)?anthro|anthropomorphic|anthromorphic|(?:source[ -]+)?furry(?:[ -]character)?', 2],
        ['anime-character', 'anime character vocabulary', 'waifu|vtuber|virtual[ -]youtuber|kemonomimi|nekomimi', 2],
    ];
    $rules = [
        ['realistic', 'photography', 'photo(?:s|graph(?:s|ed|ic|y|ing)?)?', 6, true],
        ['realistic', 'photorealism', 'photo[ -]?realis(?:tic|m)|photo[ -]?real', 6, true],
        ['realistic', 'camera capture', 'dslr|slr camera|camcorder|(?:shot|captured|taken) (?:on|with|using) (?:(?:an?|old|modern|rear|front|triple[ -]lens) ){0,3}(?:iphone|smartphone|phone|camera|canon|nikon|sony|leica)|(?:smartphone|iphone|phone) (?:camera|flash)', 5, true],
        ['realistic', 'snapshot', 'snapshot|polaroid|film still|point[ -]and[ -]shoot', 3, false],
        ['realistic', 'realism', '(?:(?:ultra|hyper)[ -]?)?realis(?:tic|m)|(?:ultra|hyper)[ -]?real|real life|lifelike|life like', 2, false],
        ['realistic', 'selfie', 'selfie|selfies', 2, false],
        ['realistic', 'candid capture', '(?:amateur|candid)(?:[ -]+[a-z]+){0,2}[ -]+selfie', 2, false],
        ['realistic', 'camera device', 'smartphone|iphone|camera phone', 2, false],
        ['realistic', 'camera viewpoint', 'camera (?:angle|viewpoint|perspective)|(?:low|high|eye[ -]level|side[ -]rear|side[ -]on)[ -]angle (?:shot|view|camera)', 2, false],
        ['realistic', 'lighting setup', $lightingPattern, 2, false],
        ['realistic', 'skin detail', 'natural skin tones?|natural skin texture|skin texture|skin pores|visible pores|detailed pores', 2, false],
        ['realistic', 'lens detail', '(?:24|35|50|85|135) ?mm(?: lens)?|depth of field|bokeh|wide[ -]angle lens|f/[0-9]+(?:\.[0-9]+)?', 2, false],
        ['realistic', 'film texture', 'film grain|analog film|analogue film|35 ?mm film', 2, false],
        ['realistic', 'natural lighting', 'natural (?:light(?:ing)?|daylight)|warm indoor light(?:ing)?|window light(?:ing)?|soft daylight|ambient light(?:ing)?', 1, false],
    ];
    [$prompt, $activeLoras, $disabledLoras] = style_active_loras($prompt, $loras);
    $sources = [['prompt', $prompt, 1], ['model', $model, 2]];
    foreach ($activeLoras as $text) $sources[] = ['lora', $text, 2];
    foreach ($tags as $text) if (is_string($text)) $sources[] = ['tag', $text, 1];
    $scores = ['anime'=>0, 'realistic'=>0];
    $strong = ['anime'=>false, 'realistic'=>false];
    $families = ['anime'=>[], 'realistic'=>[]];
    $signals = []; $seen = []; $artCues = [];
    foreach ($sources as [$source, $raw, $weight]) {
        if (in_array($source, ['model','lora'], true)) {
            $raw = preg_replace('~(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])~', ' ', $raw) ?? $raw;
        }
        $text = lower_text(str_replace(['_', '–', '—', '‑'], [' ', '-', '-', '-'], $raw));
        $text = style_without_disabled_groups($text);
        if ($source === 'tag' && preg_match('~^(?:photo(?:graph)? \(object\)|photo background)$~u', trim($text))) continue;
        // Civitai's generic 3d label also appears on photographic images. It
        // cannot identify a drawn medium; explicit "3D render"/CGI still can.
        if ($source === 'tag' && preg_match('~^(?:source[ -]+)?3[ -]?d$~u', trim($text))) continue;
        $sourceRules = $artRules;
        // A model family is supporting evidence, never a classification by
        // itself. LoRA titles often list compatibility with unrelated model
        // families; use the recorded checkpoint, not those compatibility lists.
        // Illustrious and its NoobAI derivative share one canonical cue.
        if ($source === 'model') {
            $sourceRules[] = ['illustration-family', 'illustration model family', 'illustrious(?:[ -]xl)?|noob[ -]?ai(?:[ -]xl)?', 3];
        }
        if ($source === 'lora') {
            // Bounded aliases observed in the reported catalog examples. Do
            // not infer illustration from arbitrary artist names or "style".
            $sourceRules[] = ['illustrator-adapter', 'recognized illustration style adapter', '^gelatomusume[ -]+style(?:[ -]+il)?$', 5];
            $sourceRules[] = ['animation', 'animation style adapter', '^(?:ppw[ -]+)?v7[ -]+animv4(?:[ -]+1[ -]+r2)?$', 5];
        }
        foreach (style_distinct_art_matches($text, $sourceRules, $source === 'prompt') as $match) {
            [$cue, $label, $term, $strength] = $match;
            // One canonical cue across the entire record. A copied tag, model
            // suffix, LoRA name or repeated prompt word never adds another vote.
            if (isset($artCues[$cue])) continue;
            $artCues[$cue] = true;
            $scores['anime'] += $strength * $weight;
            $strong['anime'] = $strong['anime'] || $strength >= 5;
            $families['anime'][$cue] = true;
            $signals[] = ['category'=>'anime','source'=>$source,'term'=>$term,'rule'=>$label,'cue'=>$cue];
        }
        foreach ($rules as [$category, $label, $pattern, $strength, $explicit]) {
            if ($label === 'camera viewpoint' && ($source !== 'prompt' || style_positive_match($text, $lightingPattern) === null)) continue;
            $term = style_positive_match($text, $pattern, $source === 'prompt' && $label === 'photography');
            if ($term === null || isset($seen[$source.'|'.$label])) continue;
            $seen[$source.'|'.$label] = true;
            if ($source === 'tag' && $label === 'realism' && preg_match('~^(?:realistic|realism|photorealistic|photorealism)$~u', trim($text))) {
                $explicit = true; $strength = 4;
            }
            if ($source === 'prompt' && $label === 'realism' && style_positive_match($text, '(?:(?:ultra|hyper)[ -]?)?realistic (?:portrait|image|scene)|style:\s*realistic') !== null) {
                $explicit = true; $strength = 4;
            }
            $scores[$category] += $strength * $weight;
            $families[$category][$label] = true;
            $strong[$category] = $strong[$category] || $explicit;
            $signals[] = ['category'=>$category,'source'=>$source,'term'=>$term,'rule'=>$label];
        }
    }
    $cueCount = count($artCues);
    $category = $cueCount >= CIVITAI_STYLE_ANIME_MINIMUM_CUES ? 'anime' : 'realistic';
    if ($category === 'realistic') {
        $signals[] = ['category'=>'realistic','source'=>'policy',
            'term'=>$cueCount.' distinct illustrated/Anime cue'.($cueCount === 1 ? '' : 's').'; at least '.CIVITAI_STYLE_ANIME_MINIMUM_CUES.' required for Anime',
            'rule'=>'two-cue realistic default'];
    }
    if ($category === 'realistic' && !$strong['realistic']) {
        $confidence = 0.50;
    } else {
        $other = $category === 'anime' ? 'realistic' : 'anime';
        $margin = max(0, $scores[$category] - $scores[$other]);
        $confidence = round(min(0.95, ($strong[$category] ? 0.78 : 0.60) + min(0.12, $margin / 100) + min(0.05, max(0, count($families[$category])-1) * 0.02)), 2);
    }
    return ['category'=>$category,'confidence'=>$confidence,'signals'=>$signals,'scores'=>$scores,
        'evidence'=>['animeCueCount'=>$cueCount,'animeCueMinimum'=>CIVITAI_STYLE_ANIME_MINIMUM_CUES,'animeCues'=>array_keys($artCues),'disabledLoras'=>$disabledLoras],
        'version'=>CIVITAI_STYLE_CLASSIFIER_VERSION];
}

/** Match the same resource copied as a filename, display name or inline token. */
function style_lora_identity(string $name): string {
    $name = preg_replace('~\.(?:safetensors|ckpt|pt|bin)$~iu', '', trim($name)) ?? $name;
    $key = preg_replace('~[^\p{L}\p{N}]+~u', '', lower_text($name)) ?? '';
    // These display names and filenames refer to the same reported adapters.
    // A zero-weight token must also suppress its separately captured label.
    if (in_array($key, ['gelatomusumestyle','gelatomusumestyleil'], true)) return 'gelatomusumestyle';
    if (in_array($key, ['ppwv7animv41r2','v7animv4'], true)) return 'ppwv7animv4';
    return $key;
}

/** Prompt weights are authoritative over the collector's unweighted name list.
 * Keep names/search metadata intact; exclude disabled resources only as evidence.
 * A separate positive use of the same resource remains active.
 */
function style_active_loras(string $prompt, array $loras): array {
    $number = '[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?';
    $pattern = '~<(?:lora|lyco):([^<>]+?):\s*('.$number.')\s*(?::\s*('.$number.')\s*)?>~iu';
    $states = []; $names = []; $active = [];
    // Discover names before blanking outer disabled groups, otherwise metadata
    // could resurrect a positive token inside an explicitly disabled group.
    preg_match_all($pattern, $prompt, $original, PREG_SET_ORDER);
    foreach ($original as $match) {
        $key = style_lora_identity($match[1]);
        $states[$key] = false; $names[$key] = trim($match[1]);
    }
    $prompt = style_without_disabled_groups($prompt);
    $prompt = preg_replace_callback($pattern, static function(array $match) use (&$states, &$active): string {
        $key = style_lora_identity($match[1]);
        if ((float)$match[2] > 0 || (isset($match[3]) && (float)$match[3] > 0)) {
            $states[$key] = true;
            $active[$key] = trim($match[1]);
        }
        return ' ';
    }, $prompt) ?? $prompt;
    foreach ($loras as $name) {
        if (!is_string($name)) continue;
        if (preg_match($pattern, $name, $match)) {
            if ((float)$match[2] <= 0 && (!isset($match[3]) || (float)$match[3] <= 0)) continue;
            $name = $match[1];
        }
        $key = style_lora_identity($name);
        if ($key === '' || (array_key_exists($key, $states) && !$states[$key])) continue;
        if (!isset($active[$key])) $active[$key] = $name;
    }
    $disabled = [];
    foreach ($states as $key=>$enabled) if (!$enabled) $disabled[] = $names[$key];
    return [$prompt, array_values($active), $disabled];
}

/** Prefer complete compound descriptors over nested words at the same location. */
function style_distinct_art_matches(string $text, array $rules, bool $ignoreProps): array {
    $candidates = [];
    foreach ($rules as $order=>[$cue, $label, $pattern, $strength]) {
        foreach (style_positive_matches($text, $pattern, $ignoreProps) as [$term, $offset]) {
            $candidates[] = [$cue,$label,$term,$strength,$offset,strlen($term),$order];
        }
    }
    usort($candidates, static fn(array $a, array $b): int => ($b[5] <=> $a[5]) ?: ($a[4] <=> $b[4]) ?: ($a[6] <=> $b[6]));
    $accepted = []; $ranges = [];
    foreach ($candidates as $candidate) {
        $start = $candidate[4]; $end = $start+$candidate[5];
        foreach ($ranges as [$rangeStart,$rangeEnd]) {
            if ($start < $rangeEnd && $end > $rangeStart) continue 2;
        }
        $ranges[] = [$start,$end];
        $accepted[] = $candidate;
    }
    usort($accepted, static fn(array $a, array $b): int => $a[4] <=> $b[4]);
    return $accepted;
}

/** Remove whole disabled groups, including nested positive groups inside them. */
function style_without_disabled_groups(string $text): string {
    $stack = []; $ranges = []; $length = strlen($text);
    for ($i=0; $i<$length; $i++) {
        if ($text[$i] === '\\') { $i++; continue; }
        if ($text[$i] === '(') $stack[] = $i;
        elseif ($text[$i] === ')' && $stack) {
            $start = array_pop($stack);
            $group = substr($text, $start+1, $i-$start-1);
            if (preg_match('~:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$~', $group, $match) && (float)$match[1] <= 0) $ranges[] = [$start,$i];
        }
    }
    // Blank ranges preserve byte offsets and naturally handle overlapping groups.
    foreach ($ranges as [$start,$end]) $text = substr_replace($text, str_repeat(' ', $end-$start+1), $start, $end-$start+1);
    return $text;
}

/** Return the first affirmative occurrence; local negation is not style evidence. */
function style_positive_match(string $text, string $pattern, bool $ignoreProps = false): ?string {
    $matches = style_positive_matches($text, $pattern, $ignoreProps);
    return $matches[0][0] ?? null;
}

/** Retain offsets so overlapping medium phrases cannot become multiple cues. */
function style_positive_matches(string $text, string $pattern, bool $ignoreProps = false): array {
    $positive = [];
    preg_match_all('~(?<![\p{L}\p{N}])(?:'.$pattern.')(?![\p{L}\p{N}])~u', $text, $matches, PREG_OFFSET_CAPTURE);
    foreach ($matches[0] ?? [] as [$term, $offset]) {
        $prefix = substr($text, max(0, $offset-160), min(160, $offset));
        // Deliberately bounded vocabulary: "not anime but a photo" keeps photo,
        // while "no anime or cartoon" and "not a photo" suppress the negated cues.
        $negatedStyleWord = 'a|an|any|the|explicit|artificial|filter|filters|effect|effects|stylization|stylisation|style|styles|tags|containing|references|to|of|look|like|rendered|as|and|or|source|ai|anime|animesque|japanimation|japanese|manga|manhwa|manhua|webtoon|hentai|fantasy|fantastical|cartoon|cartoons|cartoonish|cartoony|toon|photo|photographic|photorealistic|realistic|digital|comic|comics|book|art|artwork|illustration|illustrations|illustrated|drawing|drawings|drawn|hand|sketch|sketches|sketched|sketching|painting|paintings|painted|oil|acrylic|gouache|watercolor|watercolour|charcoal|graphite|ink|pencil|cgi|cg|3d|2d|3|2|d|computer|generated|animation|animated|film|movie|render|rendering|pixar|dreamworks|disney|ghibli|cel|cell|shaded|shading|line|lineart|outlines|flat|colors|colours|pixel|pixelated|sprites|vector|graphics|stylized|stylised|low|poly|polygon|voxel|claymation|clay|stop|motion|paper|papercut|origami|woodcut|linocut|lithograph|engraving|etching|halftone|screentone|cross|hatching|crosshatching|stippled|stippling|game|video|visual|novel|jrpg|chibi|super|deformed|anthro|anthropomorphic|anthromorphic|furry|character|waifu|vtuber|kemonomimi|nekomimi';
        $negatedStyleWord .= '|ecchi|speed|action|lines|illustrious|noob|ai|xl|gelatomusume';
        if (preg_match('~(?:\b(?:no|not|without|avoid|avoiding|exclude|excluding|remove|removing|omit|omitting)\b(?:[\s-]+(?:'.$negatedStyleWord.')){0,12}[\s-]+|\bnon[ -]*)$~u', $prefix)) continue;
        if (preg_match('~\b(?:non|no|not)[ -]+photo[ -]*$~u', $prefix)) continue;
        // Descriptions of an absent optical effect do not supply a positive
        // lens cue, including coordinated "no lens distortion or shallow ...".
        if (in_array($term, ['depth of field','bokeh'], true) &&
            preg_match('~\b(?:no|without)\s+(?:(?:discernible|noticeable|visible|significant|shallow|strong|any)\s+){0,3}(?:(?:lens distortion|bokeh)\s+(?:and|or)\s+(?:(?:shallow|visible|noticeable|strong)\s+){0,2})?$~u', $prefix)) continue;
        // Semi-realistic describes a blend, not an affirmative photographic
        // medium or the existing explicit "realistic portrait" declaration.
        if (preg_match('~^realis(?:tic|m)\b~u', $term) && preg_match('~\bsemi[ -]*$~u', $prefix)) continue;
        $suffix = substr($text, $offset+strlen($term), 70);
        if ($ignoreProps && preg_match('~^styl(?:iz|is)(?:ed|ation)$~u', $term)) {
            // Commercial photography can be deliberately styled. The adjective
            // is not a drawn-medium cue when that same sentence calls it a photo.
            $before = preg_replace('~^.*[.!?;\n]~s', '', $prefix) ?? $prefix;
            $after = preg_split('~[.!?;\n]~u', substr($text, $offset+strlen($term), 240), 2)[0];
            $clause = $before.$term.$after;
            if (style_positive_match($clause, 'photo(?:graph(?:ic|y)?)?|photorealistic') !== null &&
                style_positive_match($clause, 'anime|manga|hentai|cartoon|illustrat(?:ion|ed)|drawing|painting|cgi|3[ -]?d[ -]render(?:ing)?|cel[ -]shad(?:ed|ing)') === null) continue;
        }
        // A bare word can be a style tag, but natural-language actions and
        // objects (painted lips, drawn curtains, furry rugs) are not media.
        if (in_array($term, ['drawn','painted','furry'], true)) {
            $standaloneTag = preg_match('~(?:^|[,;|\n])\s*[\[(]?\s*$~u', $prefix) &&
                preg_match('~^\s*(?::\s*[0-9.]+)?\s*[\])]?\s*(?:[,;|\n]|$)~u', $suffix);
            $explicitMedium = $term !== 'furry' && preg_match('~^[ -]+(?:art|artwork|image|portrait|scene|landscape|illustration|style)\b~u', $suffix);
            if (!$standaloneTag && !$explicitMedium) continue;
        }
        if ($term === 'animated' && preg_match('~^\s+(?:expressions?|conversations?|gestures?|personality|movements?|poses?|faces?|eyes|discussions?|smiles?)\b~u', $suffix)) continue;
        if (preg_match('~^3[ -]?d$~u', $term) && preg_match('~^\s+(?:print(?:ed|ing|ers?)?|glasses|camera)\b~u', $suffix)) continue;
        if ($ignoreProps) {
            if (preg_match('~(?:illustration|drawing|painting|sketch|comic|manga|art|woodcut|linocut|lithograph|engraving|etching)~u', $term) &&
                preg_match('~\bphoto(?:graph)?\s+(?:of|showing|depicting)\s+(?:a|an|the)\s+(?:(?:framed|printed|digital|pencil|comic|book|art|small|large|colorful)\s+){0,5}$~u', $prefix)) continue;
            if (in_array($term, ['drawing','drawn'], true) && preg_match('~^\s+(?:(?:all|the|her|his|your|our)\s+)?(?:(?:immediate|direct|particular|special)\s+)?(?:(?:viewer[’\x27]s\s+)?(?:attention|focus|eye|gaze)|a breath|closer|taut|tight|together|back|near|up|aside|away|to|into|toward|towards|(?:the\s+)?fabric\s+(?:taut|tight))\b~u',$suffix)) continue;
            if (!str_starts_with($term,'photo') && preg_match('~^[ -]+(?:[a-z]+[ -]+){0,6}(?:posters?|shirts?|t[ -]?shirts?|tattoos?|prints?|logos?|stickers?|graphics?|cases?|eyeliner|makeup|costumes?|cosplay|merchandise)\b~u', $suffix, $prop) &&
                !preg_match('~\b(?:wearing|holding|person|woman|man|portrait|scene|of|in|against|with)\b~u', $prop[0])) continue;
            if (preg_match('~^\s+(?:hanging|mounted|displayed|printed)\s+(?:on|above|inside|across)\b~u',$suffix)) continue;
            if (preg_match('~\bframed(?:[ -]+[a-z]+){0,5}\s+$~u',$prefix)) continue;
            // A new comma-separated comic/animation style clause describes the image;
            // it is distinct from a comic print on the preceding clothing/prop.
            $explicitStyleClause = preg_match('~^(?:comics?(?: book)?(?: art)? style|(?:pixar|dream[ -]?works)[ -].+)$~u', $term) && preg_match('~,\s*$~u', $prefix);
            if (!$explicitStyleClause && !str_starts_with($term,'photo') && preg_match('~\b(?:case|pop socket|stickers?|underwear|t-shirt|shirt|dress|art print|abstract print|canvas|tattoos?)(?:\s+(?:with|of|has|have|having|showing|depicting|featuring|including|a|an|the|small|large|white|black|prominent|colorful|cute|like|on|her|his|their|thighs?|digital|comic|book|art)){0,12}[,:]?\s+$~u',$prefix)) continue;
            if (!str_starts_with($term,'photo') && preg_match('~\b(?:tattoos?|tattooed\s+(?:arms?|legs?|thighs?))(?:\s+(?:on|her|his|their|arms?|legs?|thighs?)){0,4},?\s+(?:of|in|with|featuring|depicting|showing|including)(?:[ -]+[a-z]+){0,6}\s+$~u',$prefix)) continue;
            if (!str_starts_with($term,'photo') && preg_match('~\b(?:screen|tv|monitor|television)\b[^.!?;\n]{0,75}\b(?:shows?|showing|displays?|displaying|playing)\b(?:[ -]+[a-z]+){0,5}\s+$~u',$prefix)) continue;
        }
        $positive[] = [$term,$offset];
    }
    return $positive;
}
