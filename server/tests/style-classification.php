<?php
declare(strict_types=1);

// Pure classifier regressions: no configuration, database, or image files are required.
require dirname(__DIR__).'/lib.php';

$checks=0;
$failures=[];
function style_check(bool $condition,string $message): void {
    global $checks,$failures;
    $checks++;
    if (!$condition) $failures[]=$message;
}

$reportedPrompt=<<<'PROMPT'
A young adult woman with fair skin and long dark brown hair pulled back in a ponytail takes a selfie while bent over, photographed from a low angle behind her. She wears a white headband across her forehead, and freckles are visible across her nose and cheeks. Her eyes look back over her right shoulder at the camera, and her lips are painted with light pink nude lipstick. She wears a white sleeveless sports bra and fitted black athletic shorts with white trim along the leg openings and waistband. The back of the shorts features silver rhinestone spelling out text "SPANK ME". Multiple delicate gold layered necklaces with small pendants hang around her neck, and she wears small stud earrings. Her back is arched as she bends at the waist, emphasizing her buttocks. The background shows a room with light wood or beige flooring, a white fluffy rug, white tiled flooring visible in the lower left corner, and a cardboard box or furniture piece on the right. The lighting is warm indoor light creating even illumination and natural skin tones. The image has the aesthetic of amateur smartphone selfie photography with athletic casual wear styling and an intimate atmosphere.
PROMPT;

$descriptiveCapturePrompt=<<<'PROMPT'
An adult lies on a textured gray quilted bedspread. Individual hair strands catch ambient light. Visible stitching and fabric texture. Directional lighting from front-left creates highlights and shadows. Camera angle is low, capturing a side-rear perspective. Facial expression drawing immediate attention. No discernible lens distortion or shallow depth of field; crisp throughout, suggesting a professional-grade setup. Controlled lighting and deliberate staging.
PROMPT;

// Each fixture supplies the same four metadata fields used by the ingestion endpoint.
// Version 6 uses the owner's binary browsing policy: affirmative art/fantasy cues
// select Anime; all remaining inputs select Realistic, with default evidence kept explicit.
$fixtures=[
    ['anime subject outranks photography under binary policy','anime','A photograph with anime portrait of a person wearing a shirt.','',[],[]],
    ['reported natural-language smartphone prompt','realistic',$reportedPrompt,'',[],[]],
    ['photograph noun','realistic','A photograph of a person in a room.','',[],[]],
    ['photographed verb','realistic','A woman photographed in warm indoor light.','',[],[]],
    ['photography noun','realistic','Amateur smartphone selfie photography.','',[],[]],
    ['photographic adjective','realistic','A photographic portrait.','',[],[]],
    ['photo noun','realistic','A photo of a person outdoors.','',[],[]],
    ['photos plural','realistic','Candid photos of people outdoors.','',[],[]],
    ['photographs plural','realistic','Photographs of a person in a room.','',[],[]],
    ['photorealism','realistic','Portrait, photorealism.','',[],[]],
    ['camera and skin details','realistic','DSLR portrait, detailed skin texture, visible pores.','',[],[]],
    ['selfie without art cues defaults to realistic','realistic','A woman taking a selfie.','',[],[]],
    ['mirror selfie without art cues defaults to realistic','realistic','A mirror selfie.','',[],[]],
    ['ordinary physical descriptions default to realistic','realistic','A woman with freckles, dark hair, brown eyes and a white shirt in a warm room.','',[],[]],
    ['generic portrait defaults to realistic','realistic','Portrait.','',[],[]],
    ['empty classifier metadata defaults to realistic','realistic','','',[],[]],
    ['anime selfie','anime','Anime selfie, cel-shaded illustration.','',[],[]],
    ['manga style','anime','Manga illustration.','',[],[]],
    ['hentai style','anime','Hentai style.','',[],[]],
    ['generic drawing belongs in the broad anime bucket','anime','Pencil drawing of a tree.','',[],[]],
    ['oil painting belongs in the anime bucket despite realism','anime','Realistic oil painting.','',[],[]],
    ['3D render belongs in the anime bucket despite realistic lighting','anime','3D render with realistic lighting.','',[],[]],
    ['affirmative anime wins mixed explicit styles','anime','Anime photorealistic.','',[],[]],
    ['negated anime and cartoon','realistic','Photograph, no anime or cartoon.','',[],[]],
    ['negated photograph','anime','Anime illustration, not a photo.','',[],[]],
    ['non-photorealistic without art cues uses realistic default','realistic','Non-photorealistic.','',[],[]],
    ['named realistic model','realistic','Portrait.','Realistic Vision checkpoint',[],[]],
    ['anime LoRA metadata','anime','Portrait.','Base checkpoint',['anime portrait LoRA'],[]],
    ['explicit realism in LoRA metadata','realistic','Portrait.','Base checkpoint',['photorealistic portrait LoRA'],[]],
    ['explicit anime tag','anime','Portrait.','',[],['anime']],
    ['explicit photographic tag','realistic','Portrait.','',[],['photography']],
    ['anime poster is a photographed prop','realistic','A photograph of an anime poster on a bedroom wall.','',[],[]],
    ['negative integer anime group is excluded','realistic','A photo of a person, (anime, cartoon, illustration:-1).','',[],[]],
    ['negative decimal anime group is excluded','realistic','A photo of a person, (anime, cartoon, illustration:-1.5).','',[],[]],
    ['negative leading-decimal anime group is excluded','realistic','A photo of a person, (anime, cartoon, illustration:-.5).','',[],[]],
    ['zero integer anime group is excluded','realistic','A photo of a person, (anime, cartoon, illustration:0).','',[],[]],
    ['zero decimal anime group is excluded','realistic','A photo of a person, (anime, cartoon, illustration:0.000).','',[],[]],
    ['positive weighted anime group remains affirmative','anime','(anime, cartoon, illustration:1.5).','',[],[]],
    ['positive fractional anime weight remains affirmative','anime','(anime:0.5).','',[],[]],
    ['negative weighted photography cannot conflict with anime','anime','Anime illustration, (photograph, photorealistic:-1.5).','',[],[]],
    ['excluded art group alone uses realistic default','realistic','(anime, cartoon, illustration:-1.5).','',[],[]],
    ['drawing attention is an idiom not a medium','realistic','A photo, drawing attention to the subject.','',[],[]],
    ['cartoon stickers are photographed props','realistic','A photo of a woman with cartoon stickers on her laptop.','',[],[]],
    ['framed illustration is a photographed prop','realistic','A smartphone photo of a room with a framed illustration on the wall.','',[],[]],
    ['photographing verb','realistic','A woman photographing herself for a selfie.','',[],[]],
    ['remove tags phrase excludes anime and illustration','realistic','Remove any tags containing anime or illustration. A photo of a person.','',[],[]],
    ['anime subject wins over photographic background','anime','Anime character against a photographic background.','',[],[]],
    ['zero inline anime LoRA is disabled','realistic','A photograph of a tree. <lora:AnimeName:0>','',[],[]],
    ['decimal zero inline anime LoRA is disabled','realistic','A photograph of a tree. <lora:AnimeName:0.000>','',[],[]],
    ['negative inline anime LoRA is disabled','realistic','A photograph of a tree. <lora:AnimeName:-1>','',[],[]],
    ['negative fractional inline anime LoRA is disabled','realistic','A photograph of a tree. <lora:AnimeName:-.5>','',[],[]],
    ['positive inline anime LoRA wins over photographic cue','anime','A photograph of a tree. <lora:AnimeName:0.5>','',[],[]],
    ['positive inline anime LoRA supplies medium','anime','A tree. <lora:AnimeName:1>','',[],[]],
    ['disabled inline resource alone uses realistic default','realistic','<lora:AnimeName:0>','',[],[]],
    ['zero outer group removes nested positive anime','realistic','A photograph of a tree, ((anime:1.5), cartoon:0).','',[],[]],
    ['negative outer group removes nested positive anime','realistic','A photograph of a tree, ((anime:1.5), illustration:-0.5).','',[],[]],
    ['positive outer group cannot restore zero inner anime','realistic','A photograph of a tree, ((anime:0):1.5).','',[],[]],
    ['affirmative anime outside a disabled group wins over photography','anime','A photograph of a tree, ((cartoon:1.2):0), anime illustration.','',[],[]],
    ['Realism Engine model name supplies realism','realistic','Portrait.','Realism Engine',[],[]],
    ['camel-case RealismEngine model name supplies realism','realistic','Portrait.','RealismEngine',[],[]],
    ['camel-case SickRealism model name supplies realism','realistic','Portrait.','SickRealism',[],[]],
    ['camel-case SickRealism LoRA name supplies realism','realistic','Portrait.','',['SickRealism'],[]],
    ['camel-case SickAnime model name supplies anime','anime','Portrait.','SickAnime',[],[]],
    ['camel-case SickAnime LoRA name supplies anime','anime','Portrait.','',['SickAnime'],[]],
    ['camel-case anime metadata wins over explicit photography','anime','A photograph of a tree.','SickAnime',[],[]],
    ['exact realistic tag supplies an explicit style','realistic','Portrait.','',[],['realistic']],
    ['descriptive realistic tag without art cues classifies realistic','realistic','Portrait.','',[],['realistic lighting']],
    ['smartphone and selfie provide independent camera clues','realistic','A smartphone selfie of an adult in a garden.','',[],[]],
    ['smartphone alone uses realistic default','realistic','An adult holding a smartphone.','',[],[]],
    ['photo object tag uses realistic default without a medium vote','realistic','Portrait.','',[],['photo (object)']],
    ['photo object tag does not conflict with anime','anime','Anime illustration of a tree.','',[],['photo (object)']],
    ['drawing all attention is an idiom','realistic','A photograph of a bright scarf, drawing all attention to its color.','',[],[]],
    ['drawing fabric taut is an action','realistic','A photograph of an adult drawing fabric taut over a wooden frame.','',[],[]],
    ['cartoon graphic on clothing is a photographed prop','realistic','A photograph of an adult wearing a shirt with a cartoon graphic.','',[],[]],
    ['cartoon tattoo is a photographed prop','realistic','A photograph of an adult with a cartoon tattoo on their arm.','',[],[]],
    ['cartoon portrait belongs in anime bucket despite realistic lighting','anime','A cartoon portrait with realistic lighting.','',[],[]],
    ['pencil drawing belongs in anime bucket despite realism','anime','A realistic pencil drawing of a tree.','',[],[]],
    ['3D render wins over photorealistic adjective','anime','A photorealistic 3D render of a tree.','',[],[]],
    ['later genuine anime wins over photographic clothing scene','anime','A photograph of an adult wearing a shirt printed with "hello". Anime illustration style.','',[],[]],
    ['quoted clothing text with later anime keeps anime medium','anime','An adult wearing a shirt printed with "hello", anime illustration style.','',[],[]],
    ['non-photo-realistic selfie without art cues uses realistic default','realistic','A non-photo-realistic selfie of an adult in a garden.','',[],[]],
    ['realistic portrait declares a source style','realistic','A realistic portrait of an adult in a garden.','',[],[]],
    ['realistic image declares a source style','realistic','A realistic image of a mountain landscape.','',[],[]],
    ['realistic scene declares a source style','realistic','A realistic scene of a quiet village.','',[],[]],
    ['oil painting wins over realistic portrait','anime','A realistic portrait of an adult, oil painting.','',[],[]],
    ['anime wins over explicit realistic portrait','anime','An anime realistic portrait of an adult.','',[],[]],
    ['negated realistic portrait without art cues uses realistic default','realistic','Not a realistic portrait.','',[],[]],
    ['amateur car selfie has corroborating capture clues','realistic','An amateur car selfie of an adult.','',[],[]],
    ['candid garden selfie has corroborating capture clues','realistic','A candid garden selfie of an adult.','',[],[]],
    ['explicit anime outweighs weak amateur selfie clues','anime','An amateur car selfie of an adult, anime.','',[],[]],
    ['anime wins over realistic tag and amateur selfie cues','anime','An amateur car selfie of an adult, anime.','',[],['realistic']],
    ['amateur portrait without art cues defaults to realistic','realistic','An amateur portrait of an adult.','',[],[]],
    ['pixel art wins over smartphone selfie cues','anime','Pixel art of an adult taking a smartphone selfie.','',[],[]],
    ['anime-patterned phone case is a photographed prop','realistic','A photograph of an adult holding an anime-patterned case.','',[],[]],
    ['anime eyeliner is a photographed appearance detail','realistic','A photograph of an adult wearing anime eyeliner.','',[],[]],
    ['manga tattoo is a photographed prop','realistic','A photograph of an adult with a manga tattoo on their arm.','',[],[]],
    ['drawing the viewer eye is an idiom','realistic','A photograph of a red umbrella, drawing the viewer’s eye toward the center.','',[],[]],
    // Version 4: the anime bucket includes explicit digital/comic illustration.
    // Materials, skin detail and simulated capture effects do not change its medium.
    ['digital illustration explicitly supplies a drawn medium','anime','A digital illustration of an adult gardener beside a tree.','',[],[]],
    ['comic art explicitly supplies a drawn medium','anime','Comic art of an adult cyclist on a quiet street.','',[],[]],
    ['comic book art explicitly supplies a drawn medium','anime','Comic book art of a mountain village.','',[],[]],
    ['comic style explicitly supplies a drawn medium','anime','A mountain village in comic style.','',[],[]],
    ['generic illustration belongs in the broad anime bucket','anime','An illustration of a mountain village.','',[],[]],
    ['drawn outlines and flat colors outweigh realistic material details','anime','An illustration of an adult wearing a coat, thick black outlines and flat colors, realistic fabric and metal details.','',[],[]],
    ['digital illustration retains its medium with realistic skin texture','anime','A digital illustration of an adult gardener, realistic skin texture and visible pores.','',[],[]],
    ['digital illustration retains its medium with realistic materials','anime','A digital illustration of a ceramic teapot, realistic materials and lifelike reflections.','',[],[]],
    ['digital illustration retains its medium with film texture','anime','A digital illustration of a village street, film grain and soft daylight.','',[],[]],
    ['digital illustration retains its medium with candid phone cues','anime','A digital illustration of an adult taking a candid smartphone selfie in a garden.','',[],[]],
    ['comic art retains its medium with simulated camera texture','anime','Comic art of an adult cyclist, candid smartphone selfie, film grain, skin texture and natural light.','',[],[]],
    ['semi-realistic digital illustration is still explicitly drawn','anime','A semi-realistic digital illustration of an adult gardener.','',[],[]],
    ['semi-realistic comic book art is still explicitly drawn','anime','Semi-realistic comic book art of a village street.','',[],[]],
    ['semi-realistic alone defaults to realistic without art cues','realistic','Semi-realistic.','',[],[]],
    ['semi-realistic portrait defaults to realistic without art cues','realistic','A semi-realistic portrait of an adult gardener.','',[],[]],
    ['space-separated semi realistic portrait defaults to realistic','realistic','A semi realistic portrait of an adult gardener.','',[],[]],
    ['digital illustration on a photographed shirt is a prop','realistic','A photograph of an adult wearing a shirt featuring a digital illustration.','',[],[]],
    ['framed digital illustration is a photographed object','realistic','A photograph of a room with a framed digital illustration on the wall.','',[],[]],
    ['digital illustration on a photographed canvas is a prop','realistic','A photograph of a room with a canvas showing a digital illustration.','',[],[]],
    ['comic book art printed on a poster is a photographed object','realistic','A photograph of a room with comic book art printed on a poster.','',[],[]],
    ['comic art shirt is a photographed clothing detail','realistic','A photograph of an adult wearing a comic art shirt.','',[],[]],
    ['trailing comic style after a shirt wins over photography','anime','A photograph of an adult wearing a shirt, comic book art style.','',[],[]],
    ['trailing comic style after a tattoo wins over photography','anime','A photograph of an adult with a tattoo, comic book art style.','',[],[]],
    ['negated digital illustration does not conflict with photography','realistic','A photograph of a tree, not a digital illustration.','',[],[]],
    ['negated digital and comic list does not conflict with photography','realistic','A photograph of a tree, no digital illustration or comic art.','',[],[]],
    ['negated comic and digital list does not conflict with photography','realistic','A photograph of a tree, not comic art or digital illustration.','',[],[]],
    ['disabled digital illustration group does not supply medium','realistic','A photograph of a tree, (digital illustration, thick outlines, flat colors:0).','',[],[]],
    ['negative digital and comic group does not supply medium','realistic','A photograph of a tree, (digital illustration, comic book art:-1).','',[],[]],
    ['explicit anime wins over actual photograph phrase','anime','An actual photograph of an adult gardener, anime illustration style.','',[],[]],
    ['explicit anime wins over photographic background phrase','anime','An anime illustration of an adult gardener against a photographic background.','',[],[]],
    // Version 5: corroborating capture descriptions and qualified drawn styles.
    ['detailed capture description establishes a realistic medium','realistic',$descriptiveCapturePrompt,'',[],[]],
    ['explicit digital illustration outweighs descriptive capture cues','anime','A digital illustration. '.$descriptiveCapturePrompt,'',[],[]],
    ['explicit anime outweighs descriptive capture cues','anime','Anime style. '.$descriptiveCapturePrompt,'',[],[]],
    ['oil painting wins over descriptive capture cues','anime','An oil painting. '.$descriptiveCapturePrompt,'',[],[]],
    ['CGI wins over descriptive capture cues','anime','CGI. '.$descriptiveCapturePrompt,'',[],[]],
    ['ordinary object color and lighting default to realistic','realistic','A wooden chair with a red cushion under warm lighting.','',[],[]],
    ['camera angle without art cues defaults to realistic','realistic','A low camera angle captures an adult standing beside a chair.','',[],[]],
    ['material detail without art cues defaults to realistic','realistic','A gray quilted bedspread with visible stitching and fabric texture.','',[],[]],
    ['drawing immediate attention is an idiom in a photograph','realistic','A photograph of a red umbrella, drawing immediate attention.','',[],[]],
    ['drawing direct attention is an idiom in a photograph','realistic','A photograph of a red umbrella, drawing direct attention.','',[],[]],
    ['drawing particular attention is an idiom in a photograph','realistic','A photograph of a red umbrella, drawing particular attention.','',[],[]],
    ['drawing special attention is an idiom in a photograph','realistic','A photograph of a red umbrella, drawing special attention.','',[],[]],
    ['drawing the viewer attention is an idiom in a photograph','realistic','A photograph of a red umbrella, drawing the viewer’s attention.','',[],[]],
    ['drawing the viewer eye with straight apostrophe is an idiom','realistic',"A photograph of a red umbrella, drawing the viewer's eye.",'',[],[]],
    ['drawing the viewer gaze is an idiom in a photograph','realistic','A photograph of a red umbrella, drawing the viewer’s gaze.','',[],[]],
    ['genuine pencil drawing wins despite drawing attention idiom','anime','A pencil drawing of a red umbrella, drawing immediate attention.','',[],[]],
    ['pencil drawing of the viewer belongs in anime bucket','anime','A pencil drawing of the viewer.','',[],[]],
    ['anthro and characteristic quality pair indicate drawn style','anime','An anthro tiger, masterpiece, absurdres.','',[],[]],
    ['anthropomorphic subject and alternate quality pair indicate drawn style','anime','An anthropomorphic tiger, absurdres, very aesthetic.','',[],[]],
    ['anthro and very awa quality pair indicate drawn style','anime','An anthro tiger, masterpiece, very awa.','',[],[]],
    ['anthro and score quality pair indicate drawn style','anime','An anthro tiger, masterpiece, score_9.','',[],[]],
    ['anthro quality combination outweighs weak realism and fur detail','anime','An anthro tiger, masterpiece, best quality, absurdres, Realism, realistic fur.','',[],[]],
    ['anthro subject alone belongs in anime bucket','anime','An anthro tiger.','',[],[]],
    ['quality tags alone use realistic default','realistic','Masterpiece, best quality, absurdres, very aesthetic, very awa.','',[],[]],
    ['quality tags do not conflict with an ordinary smartphone selfie','realistic','A smartphone selfie, masterpiece, absurdres.','',[],[]],
    ['quality tags do not conflict with descriptive camera and lighting cues','realistic','Camera angle is low, controlled lighting, masterpiece, absurdres.','',[],[]],
    ['anthro clothing prop without genuine art cues defaults to realistic','realistic','An adult wearing an anthro character shirt, masterpiece, absurdres, realistic skin.','',[],[]],
    ['anthro with generic quality tags belongs in anime bucket','anime','An anthro tiger, masterpiece, best quality.','',[],[]],
    ['anthro with one quality tag belongs in anime bucket','anime','An anthro tiger, masterpiece.','',[],[]],
    ['anthro with one characteristic quality tag belongs in anime bucket','anime','An anthro tiger, absurdres.','',[],[]],
    ['anthro remains anime even when quality tags are repeated','anime','An anthro tiger, absurdres, absurdres.','',[],[]],
    ['anthro subject wins over actual photograph and realistic fur','anime','A photograph of an anthro tiger, masterpiece, absurdres, realistic fur.','',[],[]],
    ['anthro subject wins over selfie and camera cues','anime','An anthropomorphic spotted dog taking a selfie, camera angle is low.','',[],['selfie']],
    ['anthro subject wins over explicit photograph and selfie','anime','A photograph of an anthropomorphic spotted dog taking a selfie, camera angle is low.','',[],['selfie']],
    ['ordinary camera viewpoint and lens detail classify realistic','realistic','An adult, camera angle low, depth of field.','',[],[]],
    ['quality and viewpoint tags without explicit art cue default to realistic','realistic','Masterpiece, best quality, depth of field, low camera angle.','WAI-illustrious-SDXL',[],[]],
    ['explicit Pixar style establishes an animated medium','anime','An adult gardener in Pixar style.','',[],[]],
    ['hyphenated Pixar style establishes an animated medium','anime','A Pixar-style adult gardener.','',[],[]],
    ['trailing Pixar style after clothing wins over photography','anime','A photograph of an adult wearing a shirt, Pixar style.','',[],[]],
    ['Pixar style on photographed clothing is a prop','realistic','A photograph of an adult wearing a Pixar-style shirt.','',[],[]],
    ['explicit DreamWorks animation establishes an animated medium','anime','DreamWorks animation of an adult gardener.','',[],[]],
    ['Pixar logo prop alone defaults to realistic','realistic','A Pixar logo on a plain white mug.','',[],[]],
    ['DreamWorks merchandise alone defaults to realistic','realistic','DreamWorks merchandise on a shelf.','',[],[]],
    ['Pixar logo on photographed clothing is a prop','realistic','A photograph of an adult wearing a shirt with a Pixar logo.','',[],[]],
    ['DreamWorks merchandise in a photograph is a prop','realistic','A photograph of a shelf displaying DreamWorks merchandise.','',[],[]],
    ['plural comics style explicitly supplies a drawn medium','anime','An adult gardener in comics style.','',[],[]],
    ['comics style wins over photograph phrase','anime','A photograph of an adult gardener with comics style.','',[],[]],
    ['comics style poster in a photograph is a prop','realistic','A photograph of a comics-style poster.','',[],[]],
    // Version 6: the configured two-bucket policy also covers generic art and
    // fantasy cues. Negated/disabled cues and photographed props stay excluded.
    ['fantasy prompt cue selects anime','anime','A fantasy village beside a lake.','',[],[]],
    ['fantasy cue wins over photography','anime','A photographic portrait in a fantasy setting.','',[],[]],
    ['fantasy model metadata selects anime','anime','A village beside a lake.','Fantasy Landscape',[],[]],
    ['fantasy LoRA metadata selects anime','anime','A village beside a lake.','',['Fantasy Scene'],[]],
    ['fantasy tag selects anime','anime','A village beside a lake.','',[],['fantasy']],
    ['bare digital prompt tag selects anime','anime','Portrait, digital.','',[],[]],
    ['bare digital metadata tag selects anime','anime','Portrait.','',[],['digital']],
    ['parenthesized digital tag selects anime','anime','Portrait, (digital).','',[],[]],
    ['positive weighted digital tag selects anime','anime','Portrait, (digital:1.2).','',[],[]],
    ['bracketed digital tag selects anime','anime','Portrait, [digital].','',[],[]],
    ['negative weighted bare digital tag remains excluded','realistic','Portrait, (digital:-0.5).','',[],[]],
    ['digital art cue selects anime','anime','Digital art of a mountain landscape.','',[],[]],
    ['digital painting cue selects anime','anime','Digital painting of a mountain landscape.','',[],[]],
    ['digital model metadata selects anime','anime','Portrait.','DigitalArt Model',[],[]],
    ['digital LoRA metadata selects anime','anime','Portrait.','',['Digital Illustration'],[]],
    ['digital art wins over photographic capture','anime','A photograph of a mountain landscape, digital art.','',[],[]],
    ['digital camera is a device not an art cue','realistic','A digital camera photograph of a mountain landscape.','',[],[]],
    ['digital clock is a device not an art cue','realistic','A digital clock on a wooden desk.','',[],[]],
    ['digital watch is a device not an art cue','realistic','An adult wearing a digital watch.','',[],[]],
    ['digital display is a device not an art cue','realistic','A wall-mounted digital display shows the time.','',[],[]],
    ['digital screen is a device not an art cue','realistic','A digital screen on a wooden desk.','',[],[]],
    ['digital camera metadata tag is not an art cue','realistic','Portrait.','',[],['digital camera']],
    ['line art alone selects anime','anime','Line art of a mountain village.','',[],[]],
    ['line art wins over strong photography','anime','An actual photograph of a village, line art.','',[],[]],
    ['generic painting selects anime','anime','A painting of a mountain village.','',[],[]],
    ['watercolor selects anime','anime','Watercolor of a mountain village.','',[],[]],
    ['animation selects anime','anime','An animated village scene.','',[],[]],
    ['3D rendering selects anime','anime','A 3D rendering of a mountain village.','',[],[]],
    ['neutral prompt with no art cues defaults realistic','realistic','A blue cup on a wooden table.','',[],[]],
    ['negated anime without a photo cue defaults realistic','realistic','Portrait, no anime.','',[],[]],
    ['negated fantasy without a photo cue defaults realistic','realistic','Portrait, no fantasy.','',[],[]],
    ['negated digital without a photo cue defaults realistic','realistic','Portrait, no digital.','',[],[]],
    ['negated fantasy and anime list defaults realistic','realistic','Portrait, no fantasy or anime.','',[],[]],
    ['negated art list defaults realistic','realistic','Portrait, no drawing or painting or CGI.','',[],[]],
    ['negative fantasy weight does not select anime','realistic','Portrait, (fantasy:-1).','',[],[]],
    ['zero digital weight does not select anime','realistic','Portrait, (digital:0).','',[],[]],
    ['disabled inline fantasy LoRA defaults realistic','realistic','Portrait. <lora:FantasyScene:0>','',[],[]],
    ['negative inline digital LoRA defaults realistic','realistic','Portrait. <lora:DigitalArt:-1>','',[],[]],
    ['positive inline fantasy LoRA wins over photography','anime','A photograph of a tree. <lora:FantasyScene:1>','',[],[]],
    ['fantasy poster prop does not select anime','realistic','A photograph of a fantasy poster on a wall.','',[],[]],
    ['digital art shirt prop does not select anime','realistic','A photograph of an adult wearing a digital art shirt.','',[],[]],
    ['painting photographed as an object stays realistic','realistic','A photograph of a painting on a wall.','',[],[]],
    ['drawing attention idiom without photography uses default','realistic','A red umbrella drawing immediate attention.','',[],[]],
    ['negated model cue uses realistic default','realistic','Portrait.','No anime',[],[]],
    ['negated LoRA cue uses realistic default','realistic','Portrait.','',['No fantasy'],[]],
    ['negated metadata tag uses realistic default','realistic','Portrait.','',[],['no digital']],
];

foreach ($fixtures as [$name,$expected,$prompt,$model,$loras,$tags]) {
    try {
        $actual=classify_style($prompt,$model,$loras,$tags);
        style_check(($actual['category']??null)===$expected,$name.': expected '.$expected.', got '.($actual['category']??'missing'));
        style_check(is_numeric($actual['confidence']??null) && $actual['confidence']>=0 && $actual['confidence']<=1,$name.': confidence must be between 0 and 1');
        style_check(is_array($actual['signals']??null) && is_array($actual['scores']??null),$name.': evidence signals and scores must be present');
        style_check(($actual['version']??null)===6,$name.': classifier evidence must identify version 6');
        style_check(in_array($actual['category']??null,['anime','realistic'],true),$name.': binary policy must never return uncertain');
    } catch (Throwable $error) {
        style_check(false,$name.': threw '.$error->getMessage());
    }
}

foreach (['anime','photorealistic','photography'] as $term) {
    $single=classify_style($term,'',[],[]);
    $repeated=classify_style(implode(', ',array_fill(0,20,$term)),'',[],[]);
    style_check($single['category']===$repeated['category'],$term.': repetition must not change the category');
    style_check($single['scores']===$repeated['scores'],$term.': repetition must not inflate evidence scores');
    style_check($single['confidence']===$repeated['confidence'],$term.': repetition must not inflate confidence');
}

$descriptiveStyle=classify_style($descriptiveCapturePrompt,'',[],[]);
style_check(!array_filter($descriptiveStyle['signals']??[],static fn(array $signal): bool => ($signal['rule']??'')==='lens detail'),
    'negated lens distortion and shallow depth of field must not supply affirmative lens evidence');

foreach (['', 'Portrait.', 'A blue cup on a wooden table.', 'Masterpiece, best quality, absurdres.', '(anime, fantasy, digital:0).'] as $defaultPrompt) {
    $defaultStyle=classify_style($defaultPrompt,'',[],[]);
    $defaultSignals=array_filter($defaultStyle['signals']??[],static fn(array $signal): bool =>
        ($signal['category']??'')==='realistic' && ($signal['source']??'')==='policy' && ($signal['rule']??'')==='realistic default');
    style_check($defaultStyle['category']==='realistic','no affirmative art cue must use the realistic policy default');
    style_check(count($defaultSignals)===1,'realistic fallback must store one explicit policy default signal');
    style_check($defaultStyle['confidence']>0 && $defaultStyle['confidence']<=0.6,'policy default confidence must remain modest rather than implying visual certainty');
    style_check($defaultStyle['scores']['anime']===0,'generic quality and disabled art cues must not accumulate anime scores');
}

$mixedStyle=classify_style('An actual photograph, anime illustration.','',[],[]);
style_check($mixedStyle['category']==='anime','affirmative art must win the binary category when photography is also explicit');
style_check($mixedStyle['scores']['anime']>0 && $mixedStyle['scores']['realistic']>0,'binary priority must retain conflicting source evidence for inspection');
style_check(!array_filter($mixedStyle['signals']??[],static fn(array $signal): bool => ($signal['rule']??'')==='realistic default'),
    'anime decision must not carry a realistic fallback signal');

echo json_encode(['ok'=>!$failures,'checks'=>$checks,'suite'=>'style-classification','failures'=>$failures],JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE).PHP_EOL;
exit($failures?1:0);
