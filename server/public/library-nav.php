<?php
$libraryActive=$libraryActive??'images';
$libraryLinks=[
 'images'=>['Images','/','imagesNav'],
 'popular'=>['Popular','/popular.php','popularNav'],
 'models'=>['Models','/discovery.php?kind=models','modelsNav'],
 'loras'=>['LoRAs','/discovery.php?kind=loras','lorasNav'],
 'creators'=>['Creators','/discovery.php?kind=creators','creatorsNav'],
 'recipes'=>['Recipes','/discovery.php?kind=recipes','recipesNav'],
 'explorer'=>['Prompt Explorer','/discovery.php?kind=phrases','explorerNav'],
 'discover'=>['Discover','/discover.php','discoverNav'],
];
?>
<nav class="library-nav" aria-label="Library">
<?php foreach ($libraryLinks as $key=>[$label,$url,$id]): ?>
<a id="<?= $id ?>" data-library-nav="<?= $key ?>" href="<?= htmlspecialchars($url,ENT_QUOTES,'UTF-8') ?>"<?= $libraryActive===$key?' aria-current="page"':'' ?>><?= $label ?></a>
<?php endforeach; ?>
</nav>
