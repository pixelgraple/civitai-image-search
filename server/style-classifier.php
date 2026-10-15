<?php
declare(strict_types=1);
const CIVITAI_STYLE_CLASSIFIER_VERSION = 6;

/** Library sorting policy, not a visual inspection or a statistical probability. */
function classify_prompt_style(string $prompt, string $model, array $loras, array $tags): array {
    // Related spellings share one rule so repeated/overlapping words cannot
    // inflate a score. Content words such as hair, clothes and gender are absent.
    $anthroPattern = 'anthro|anthropomorphic|anthromorphic|furry character';
    $lightingPattern = '(?:controlled|studio|directional) lighting|lighting is directional|(?:professional[ -]grade|studio) (?:lighting )?setup';
    $rules = [
        ['anime', 'anime medium', 'anime|manga|hentai|manhwa|manhua|japanese animation', 6, true],
        ['anime', 'fantasy style', 'fantasy', 6, true],
        // A bare digital tag or digital-art phrase describes a style. A digital
        // camera, watch or screen describes an object, not the image medium.
        ['anime', 'digital art style', 'digital(?:[ -]+(?:art(?:work)?|painting|drawing|illustration|render(?:ing)?|animation|style)|(?=\s*(?:[,;|):\]]|\.(?:\s|$)|$)))', 6, true],
        ['anime', 'digital illustration', 'digital illustration', 6, true],
        ['anime', 'comic illustration', 'comics?(?: book)? art(?: style)?|comics?(?: book)? illustration|comics?(?: book)? style', 6, true],
        ['anime', 'animated film style', '(?:pixar|dream[ -]?works)(?:[ -](?:inspired|like))?(?:[ -](?:3d|3 d|animated|animation|cartoon))?[ -](?:style|animation|animated(?: film)?|look|aesthetic)|(?:3[ -]?d|computer)[ -]animat(?:ed|ion)(?: film)?(?:[ -]style)?', 6, true],
        ['anime', 'cel shading', 'cel[ -]shad(?:ed|ing)|cell[ -]shad(?:ed|ing)', 5, true],
        ['anime', 'anthro character', $anthroPattern, 2, false],
        ['anime', 'anime vocabulary', 'waifu|vtuber|danbooru|safebooru', 2, false],
        ['anime', 'line art', 'lineart|line art', 2, false],
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
    $prompt = style_without_disabled_groups($prompt);
    $inlineLoras = [];
    // Resource names are metadata, not prose. A disabled resource cannot supply
    // style evidence; a positive resource uses the same rules as named LoRAs.
    $prompt = preg_replace_callback('~<(?:lora|lyco):([^<>]+):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*>~iu', static function(array $match) use (&$inlineLoras): string {
        if ((float)$match[2] > 0) $inlineLoras[] = $match[1];
        return ' ';
    }, $prompt) ?? $prompt;
    $sources = [['prompt', $prompt, 1], ['model', $model, 2]];
    foreach ($inlineLoras as $text) $sources[] = ['lora', $text, 2];
    foreach ($loras as $text) if (is_string($text)) $sources[] = ['lora', $text, 2];
    foreach ($tags as $text) if (is_string($text)) $sources[] = ['tag', $text, 1];
    $scores = ['anime'=>0, 'realistic'=>0];
    $strong = ['anime'=>false, 'realistic'=>false];
    $families = ['anime'=>[], 'realistic'=>[]];
    $signals = []; $seen = [];
    foreach ($sources as [$source, $raw, $weight]) {
        if (in_array($source, ['model','lora'], true)) {
            $raw = preg_replace('~(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])~', ' ', $raw) ?? $raw;
        }
        $text = lower_text(str_replace(['_', '–', '—', '‑'], [' ', '-', '-', '-'], $raw));
        // Negative/zero weighted prompt groups express exclusions. Never treat
        // their words as positive style evidence, including comma-separated groups.
        $text = style_without_disabled_groups($text);
        if ($source === 'tag' && preg_match('~^(?:photo(?:graph)? \(object\)|photo background)$~u', trim($text))) continue;
        $medium = style_positive_match($text, 'oil painting|painting|watercolor|watercolour|drawing|illustration|cartoon|animation|animated|3[ -]?d render(?:ing)?|cgi|digital painting|comic book art|pixel art', $source === 'prompt');
        if ($medium !== null) {
            if (!isset($seen[$source.'|other medium'])) {
                $seen[$source.'|other medium'] = true;
                $scores['anime'] += 6 * $weight;
                $strong['anime'] = true; $families['anime']['illustrated medium'] = true;
                $signals[] = ['category'=>'anime','source'=>$source,'term'=>$medium,'rule'=>'illustrated medium'];
            }
        }
        // The library's Anime bucket includes illustrated and animated media.
        if ($source === 'prompt' && style_positive_match($text, 'illustration', true) !== null &&
            style_positive_match($text, '(?:thick|bold) (?:black )?outlines?', true) !== null &&
            style_positive_match($text, 'flat colou?rs?', true) !== null) {
            $scores['anime'] += 6; $strong['anime'] = true; $families['anime']['comic rendering'] = true;
            $signals[] = ['category'=>'anime','source'=>$source,'term'=>'illustration, outlines and flat colors','rule'=>'comic rendering'];
        }
        if ($source === 'prompt') {
            // Quality adjectives alone are not a medium. A cluster containing
            // a distinctive booru-style token supports an affirmative anthro
            // character. Quality tags alone must not oppose photographic cues.
            $quality = []; $distinctive = false;
            foreach (['masterpiece'=>'masterpiece', 'quality'=>'(?:best|highest|perfect) quality',
                'resolution'=>'absurdres', 'aesthetic'=>'very aesthetic', 'awa'=>'very awa',
                'score'=>'score[ _](?:9|8[ _]up|7[ _]up)'] as $family=>$pattern) {
                $term = style_positive_match($text, $pattern);
                if ($term === null) continue;
                $quality[] = $term;
                $distinctive = $distinctive || !in_array($family, ['masterpiece','quality'], true);
            }
            if (count($quality) >= 2 && $distinctive && style_positive_match($text, $anthroPattern, true) !== null) {
                $scores['anime'] += 3; $families['anime']['booru art tags'] = true;
                $signals[] = ['category'=>'anime','source'=>$source,'term'=>implode(', ', $quality),'rule'=>'booru art tags'];
            }
        }
        foreach ($rules as [$category, $label, $pattern, $strength, $explicit]) {
            // Viewpoint and depth-of-field tags occur in illustrated prompts.
            // A viewpoint adds photographic evidence only with a lighting setup.
            if ($label === 'camera viewpoint' && ($source !== 'prompt' || style_positive_match($text, $lightingPattern) === null)) continue;
            $term = style_positive_match($text, $pattern, $source === 'prompt' && ($category === 'anime' || $label === 'photography'));
            if ($term === null || isset($seen[$source.'|'.$label])) continue;
            $seen[$source.'|'.$label] = true;
            // Keep photographic evidence for explanations, even when an Anime
            // cue takes precedence under the library's binary sorting policy.
            if ($source === 'tag' && $label === 'realism' && preg_match('~^(?:realistic|realism|photorealistic|photorealism)$~u', trim($text))) {
                $explicit = true; $strength = 4;
            }
            if ($source === 'prompt' && $label === 'realism' && style_positive_match($text, '(?:(?:ultra|hyper)[ -]?)?realistic (?:portrait|image|scene)|style:\s*realistic') !== null) {
                $explicit = true; $strength = 4;
            }
            $scores[$category] += $strength * $weight;
            $families[$category][$label] = true;
            $strong[$category] = $strong[$category] || $explicit;
            $signals[] = ['category'=>$category, 'source'=>$source, 'term'=>$term, 'rule'=>$label];
        }
    }
    // User-selected binary policy: any affirmative art/fantasy/Anime cue wins;
    // everything else goes into Realistic, including sparse metadata. This is
    // a sorting default, not evidence that the image is an actual photograph.
    $category = $scores['anime'] > 0 ? 'anime' : 'realistic';
    if ($category === 'realistic' && !$strong['realistic']) {
        $confidence = 0.50;
        $signals[] = ['category'=>'realistic','source'=>'policy','term'=>'No affirmative Anime, fantasy or illustrated-style cue','rule'=>'realistic default'];
    } else {
        $other = $category === 'anime' ? 'realistic' : 'anime';
        $margin = max(0, $scores[$category] - $scores[$other]);
        $confidence = round(min(0.95, ($strong[$category] ? 0.78 : 0.60) + min(0.12, $margin / 100) + min(0.05, (count($families[$category])-1) * 0.02)), 2);
    }
    return ['category'=>$category, 'confidence'=>$confidence, 'signals'=>$signals, 'scores'=>$scores, 'version'=>CIVITAI_STYLE_CLASSIFIER_VERSION];
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
    preg_match_all('~(?<![\p{L}\p{N}])(?:'.$pattern.')(?![\p{L}\p{N}])~u', $text, $matches, PREG_OFFSET_CAPTURE);
    foreach ($matches[0] ?? [] as [$term, $offset]) {
        $prefix = substr($text, max(0, $offset-160), min(160, $offset));
        // Deliberately bounded vocabulary: "not anime but a photo" keeps photo,
        // while "no anime or cartoon" and "not a photo" suppress the negated cues.
        if (preg_match('~(?:\b(?:no|not|without|avoid|avoiding|exclude|excluding|remove|removing|omit|omitting)\b(?:\s+(?:a|an|any|the|style|styles|tags|containing|references|to|of|look|like|rendered|as|and|or|anime|manga|hentai|fantasy|cartoon|photo|photographic|photorealistic|digital|comic|book|art|illustration|drawing|painting|cgi|rendering)){0,8}\s+|\bnon[ -]*)$~u', $prefix)) continue;
        if (preg_match('~\b(?:non|no|not)[ -]+photo[ -]*$~u', $prefix)) continue;
        // Descriptions of an absent optical effect do not supply a positive
        // lens cue, including coordinated "no lens distortion or shallow ...".
        if (in_array($term, ['depth of field','bokeh'], true) &&
            preg_match('~\b(?:no|without)\s+(?:(?:discernible|noticeable|visible|significant|shallow|strong|any)\s+){0,3}(?:(?:lens distortion|bokeh)\s+(?:and|or)\s+(?:(?:shallow|visible|noticeable|strong)\s+){0,2})?$~u', $prefix)) continue;
        // Semi-realistic describes a blend, not an affirmative photographic
        // medium or the existing explicit "realistic portrait" declaration.
        if (preg_match('~^realis(?:tic|m)\b~u', $term) && preg_match('~\bsemi[ -]*$~u', $prefix)) continue;
        if ($ignoreProps) {
            $suffix = substr($text, $offset+strlen($term), 70);
            if (preg_match('~(?:illustration|drawing|painting|comic(?: book)? art)~u', $term) &&
                preg_match('~\bphoto(?:graph)?\s+(?:of|showing|depicting)\s+(?:a|an|the)\s+(?:(?:framed|printed|digital|pencil|comic|book|art|small|large|colorful)\s+){0,5}$~u', $prefix)) continue;
            if ($term==='drawing' && preg_match('~^\s+(?:(?:all|the|her|his|your|our)\s+)?(?:(?:immediate|direct|particular|special)\s+)?(?:(?:viewer[’\x27]s\s+)?(?:attention|focus|eye|gaze)|a breath|closer|taut|tight|together|back|near|(?:the\s+)?fabric\s+(?:taut|tight))\b~u',$suffix)) continue;
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
        return $term;
    }
    return null;
}
