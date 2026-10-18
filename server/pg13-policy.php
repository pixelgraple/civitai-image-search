<?php
declare(strict_types=1);

/** A versioned metadata policy. An unreviewed image is never guaranteed visually safe. */
const PG13_POLICY_VERSION = 2;

function pg13_vocabulary(): array {
    static $vocabulary;
    if (is_array($vocabulary)) return $vocabulary;
    $raw=file_get_contents(__DIR__.'/pg13-vocabulary.json');
    if ($raw===false) throw new RuntimeException('PG-13 vocabulary unavailable.');
    $data=json_decode($raw,true,32,JSON_THROW_ON_ERROR);
    if (($data['policyVersion']??null)!==PG13_POLICY_VERSION || !is_array($data['terms']??null) || count($data['terms'])<1000)
        throw new RuntimeException('PG-13 vocabulary is invalid.');
    return $vocabulary=$data;
}

function pg13_block_terms(): array { return pg13_vocabulary()['terms']; }

function pg13_normalize(string $text): string {
    if (!preg_match('//u',$text)) throw new RuntimeException('Invalid PG-13 input encoding.');
    $text=html_entity_decode($text,ENT_QUOTES|ENT_HTML5,'UTF-8');
    if (class_exists('Normalizer')) {
        $normalized=Normalizer::normalize($text,Normalizer::FORM_KC);
        if ($normalized===false) throw new RuntimeException('PG-13 normalization failed.');
        $text=$normalized;
    }
    // Preserve CamelCase model/LoRA word boundaries before case folding.
    $text=preg_replace('/([a-z])([A-Z])/u','$1 $2',$text)??$text;
    $text=preg_replace('/([A-Z]{2,})([A-Z][a-z])/u','$1 $2',$text)??$text;
    $text=lower_text($text);
    $text=strtr($text,[
        '0'=>'o','1'=>'i','3'=>'e','4'=>'a','5'=>'s','7'=>'t','@'=>'a','$'=>'s',
        'а'=>'a','е'=>'e','о'=>'o','р'=>'p','с'=>'c','х'=>'x','у'=>'y','і'=>'i','ј'=>'j',
        'α'=>'a','ο'=>'o','ρ'=>'p','ι'=>'i',
        'á'=>'a','à'=>'a','â'=>'a','ä'=>'a','ã'=>'a','å'=>'a','é'=>'e','è'=>'e','ê'=>'e','ë'=>'e',
        'í'=>'i','ì'=>'i','î'=>'i','ï'=>'i','ó'=>'o','ò'=>'o','ô'=>'o','ö'=>'o','õ'=>'o',
        'ú'=>'u','ù'=>'u','û'=>'u','ü'=>'u','ý'=>'y','ÿ'=>'y','ç'=>'c','ñ'=>'n',
    ]);
    // Zero-width/format marks and accents must not split an otherwise blocked word.
    $text=preg_replace('/[\p{Cf}\p{Mn}]/u','',$text)??$text;
    // Common censored spellings still signal adult content.
    $text=preg_replace(
        ['/(?<!\p{L})p[*#]+rn(?!\p{L})/u','/(?<!\p{L})b[*#]+bs(?!\p{L})/u','/(?<!\p{L})n[*#]+des(?!\p{L})/u','/(?<!\p{L})f[*#]+ck(?!\p{L})/u'],
        ['porn','boobs','nudes','fuck'],$text)??$text;
    $text=preg_replace('/[^\p{L}\p{N}*]+/u',' ',$text)??$text;
    return trim(preg_replace('/\s+/u',' ',$text)??$text);
}

/** Small regex batches avoid the PCRE compilation limit of one enormous dictionary. */
function pg13_block_patterns(): array {
    static $patterns;
    if (is_array($patterns)) return $patterns;
    $parts=[]; $normalizedTerms=[];
    foreach (pg13_block_terms() as $term) {
        if (!is_string($term) || $term==='') throw new RuntimeException('Invalid PG-13 term.');
        $prefix=str_ends_with($term,'*');
        $normalized=pg13_normalize($prefix?substr($term,0,-1):$term);
        if ($normalized==='') continue;
        $normalizedTerms[$normalized.($prefix?'*':'')]=[$normalized,$prefix];
    }
    $single=[];
    foreach ($normalizedTerms as [$normalized,$prefix]) if (!$prefix && !str_contains($normalized,' ')) $single[$normalized]=true;
    foreach ($normalizedTerms as [$normalized,$prefix]) {
        $words=explode(' ',$normalized);
        // A phrase containing an already-blocked standalone term adds no runtime work.
        if (count($words)>1 && array_filter($words,static fn($word)=>isset($single[$word]))) continue;
        $escaped=[];
        foreach ($words as $word) {
            $escaped[]=preg_match('/^[a-z]{4,}$/D',$word)
                ? implode(' *',str_split($word)) : preg_quote($word,'~');
        }
        $part=implode(' +',$escaped).($prefix?'[\p{L}\p{N}]*':'');
        if (!preg_match('/[\p{Han}\p{Hiragana}\p{Katakana}\p{Hangul}]/u',$normalized))
            $part='(?<![\p{L}\p{N}])'.$part.'(?![\p{L}\p{N}])';
        $parts[$part]=true;
    }
    $patterns=[];
    foreach (array_chunk(array_keys($parts),75) as $chunk) $patterns[]='~(?:'.implode('|',$chunk).')~u';
    // Explicit body/content terms also match spaced lettering without consuming
    // a following one-letter word (for example, "n u d e a portrait").
    $spelled=['boob','boobs','boobies','breast','breasts','nipple','nipples','areola','nude','naked','topless','porn','hentai','nsfw','pussy','vagina','vulva','penis','genitals','cock','dick','fuck'];
    $parts=[];
    foreach ($spelled as $word) $parts[]=implode(' *',str_split($word));
    array_unshift($patterns,'~(?<![\p{L}\p{N}])(?:'.implode('|',$parts).')(?![\p{L}\p{N}])~u');
    return $patterns;
}

function pg13_matches_normalized(string $text): bool {
    foreach (pg13_block_patterns() as $pattern) {
        $match=preg_match($pattern,$text);
        if ($match===false) throw new RuntimeException('PG-13 matcher failed: '.preg_last_error_msg());
        if ($match===1) return true;
    }
    return false;
}

function catalog_has_pg13_term(mixed $value): int {
    if (!is_string($value) && $value!==null) return 1;
    return pg13_matches_normalized(pg13_normalize((string)$value)) ? 1 : 0;
}

function pg13_safe_for_fields(string $prompt,array $tags,string $model,array $loras): int {
    $normalizedPrompt=pg13_normalize($prompt);
    if ($normalizedPrompt==='' || !preg_match('/\p{L}/u',$normalizedPrompt)) return 0;
    foreach ([$prompt,$model,...$tags,...$loras] as $value) {
        if (!is_string($value) || catalog_has_pg13_term($value)===1) return 0;
    }
    // Resource names often concatenate adult keywords, e.g. "FinePorn" or
    // "my_nsfw_model". Restrict substring checks to resource identifiers.
    $resources=pg13_normalize($model.' '.implode(' ',$loras));
    $compact=str_replace(' ','',$resources);
    foreach (pg13_vocabulary()['resourceFragments'] as $fragment) if (str_contains($compact,$fragment)) return 0;
    return 1;
}
