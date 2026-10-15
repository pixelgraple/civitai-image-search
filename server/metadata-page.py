#!/usr/bin/env python3
"""Extract metadata from an exact public image's embedded JSON, without requests.

Only image records with the requested ID and image queries whose input has that
ID can contribute. Page prose, captions, logged-in accounts, model authors, and
recommended images never supply generation metadata or uploader names.
"""
from __future__ import annotations

from html.parser import HTMLParser
import json
import math
import re

MAX_HTML_CHARS = 16 * 1024 * 1024
MAX_JSON_CHARS = 16 * 1024 * 1024
MAX_NODES = 250000
MAX_DEPTH = 80
MAX_LIST_ITEMS = 200
REACTION_KEYS = ("likeCount", "heartCount", "laughCount", "cryCount", "buzzCount")
REACTION_ALIASES = {
    "likeCount": ("likeCount", "likeCountAllTime"),
    "heartCount": ("heartCount", "heartCountAllTime"),
    "laughCount": ("laughCount", "laughCountAllTime"),
    "cryCount": ("cryCount", "cryCountAllTime"),
    "buzzCount": ("buzzCount", "buzzCountAllTime", "tippedAmountCountAllTime"),
}
EXCLUDED_BRANCHES = frozenset((
    "comment", "comments", "user", "users", "creator", "creators", "profile", "profiles",
    "author", "authors", "session", "account", "accounts", "model", "models",
    "modelversion", "modelversions", "resource", "resources", "currentuser",
))
IMAGE_CONTEXTS = frozenset(("image", "images", "imagebyid", "imagedata"))
DETAIL_PROCEDURES = frozenset(("get", "getbyid", "getimage", "getimagedetails", "getmetadata"))


def valid_id(value: object) -> bool:
    return (isinstance(value, (str, int)) and not isinstance(value, bool)
            and bool(re.fullmatch(r"[1-9]\d{0,19}", str(value))))


def text(value: object, limit: int = 200) -> str:
    if not isinstance(value, str):
        return ""
    # Match the catalog's bounded strings, discarding embedded NUL controls.
    return value.replace("\x00", "").strip()[:limit]


def unique_strings(values: list, limit: int = MAX_LIST_ITEMS) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = text(value)
        if value and value not in seen:
            result.append(value)
            seen.add(value)
            if len(result) >= limit:
                break
    return result


class JSONScripts(HTMLParser):
    """JSON script reader with cumulative and individual input bounds."""
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.documents: list[object] = []
        self.capturing = False
        self.parts: list[str] = []
        self.length = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag != "script":
            return
        attributes = dict(attrs)
        self.capturing = (attributes.get("id") == "__NEXT_DATA__"
                          or str(attributes.get("type", "")).lower() in ("application/json", "application/ld+json"))
        self.parts = []

    def handle_data(self, data: str) -> None:
        if not self.capturing:
            return
        self.length += len(data)
        if self.length > MAX_JSON_CHARS:
            raise ValueError("Page JSON exceeds the size limit")
        self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "script" or not self.capturing:
            return
        if len(self.documents) >= 128:
            raise ValueError("Page JSON exceeds the document limit")
        try:
            self.documents.append(json.loads("".join(self.parts)))
        except json.JSONDecodeError:
            pass
        except (RecursionError, OverflowError):
            raise ValueError("Page JSON exceeds the structural limit") from None
        self.capturing = False
        self.parts = []


def query_identity(value: dict) -> tuple[str, str, object]:
    """Read TanStack/tRPC query keys; never infer identity from arbitrary IDs."""
    key = value.get("queryKey")
    if not isinstance(key, list) or not key:
        return "", "", None
    path = key[0]
    if isinstance(path, str):
        path = path.split(".")
    if not isinstance(path, list) or len(path) != 2 or not all(isinstance(item, str) for item in path):
        return "", "", None
    argument = key[1] if len(key) > 1 and isinstance(key[1], dict) else {}
    inputs = argument.get("input")
    if isinstance(inputs, dict) and isinstance(inputs.get("json"), dict):
        inputs = inputs["json"]
    image_id = inputs.get("id", inputs.get("imageId")) if isinstance(inputs, dict) else None
    return path[0].lower(), path[1].lower(), image_id


def query_data(value: dict) -> object:
    state = value.get("state")
    if not isinstance(state, dict) or state.get("status") == "error":
        return None
    data = state.get("data")
    # tRPC superjson wraps the result in {json: ..., meta: ...}. Do not walk
    # unrelated descendants to find a generation payload.
    if isinstance(data, dict) and "json" in data:
        data = data["json"]
    return data


def explicit_id_matches(value: dict, image_id: str) -> bool:
    """Every provided image identity must agree, including query-bound data."""
    ids = [value[key] for key in ("id", "imageId") if key in value]
    return bool(ids) and all(valid_id(candidate) and str(candidate) == image_id for candidate in ids)


def has_conflicting_id(value: dict, image_id: str) -> bool:
    return any(key in value and (not valid_id(value[key]) or str(value[key]) != image_id)
               for key in ("id", "imageId"))


def looks_like_image(value: dict, context: str) -> bool:
    return (context.lower() in IMAGE_CONTEXTS
            or ("width" in value and "height" in value)
            or ("url" in value and any(key in value for key in ("postId", "meta", "metadata"))))


def page_reactions(value: object) -> dict[str, int]:
    if not isinstance(value, dict) or value.get("statsUnknown") is True:
        return {}
    result: dict[str, int] = {}
    for key, aliases in REACTION_ALIASES.items():
        for alias in aliases:
            number = value.get(alias)
            if (isinstance(number, (int, float)) and not isinstance(number, bool)
                    and 0 <= number <= 9007199254740991 and math.isfinite(number)
                    and int(number) == number):
                result[key] = int(number)
    return result


def creator_name(value: dict) -> str:
    user = value.get("user")
    candidate = user.get("username") if isinstance(user, dict) else None
    return text(candidate).lstrip("@") or text(value.get("username")).lstrip("@")


def tag_names(values: list) -> list[str]:
    names: list = []
    for item in values[:2000]:
        if isinstance(item, str):
            names.append(item)
        elif isinstance(item, dict):
            tag = item.get("tag")
            names.append(item.get("name"))
            if isinstance(tag, dict):
                names.append(tag.get("name"))
    return unique_strings(names)


class Metadata:
    def __init__(self, image_id: str) -> None:
        self.image_id = image_id
        self.fields: dict = {}
        self.available: set[str] = set()
        self.priorities: dict[str, int] = {}
        self.reaction_priorities: dict[str, int] = {}
        self.matched = False
        self.hidden = False

    def put(self, key: str, value: object, priority: int) -> None:
        self.available.add(key)
        if key in ("tags", "loras") and isinstance(value, list):
            # Separate exact-image records may expose different named resources.
            self.fields[key] = unique_strings([*self.fields.get(key, []), *value])
            self.priorities[key] = max(priority, self.priorities.get(key, -1))
        elif key == "reactions" and isinstance(value, dict):
            counts = self.fields.setdefault(key, {})
            for reaction, count in value.items():
                if reaction not in counts or priority >= self.reaction_priorities.get(reaction, -1):
                    counts[reaction] = count
                    self.reaction_priorities[reaction] = priority
        elif not self.fields.get(key) or (value and priority >= self.priorities.get(key, -1)):
            # An empty higher-priority record cannot hide a later exact match's
            # nonempty observation; a blank record cannot erase observed data.
            self.fields[key] = value
            self.priorities[key] = priority

    def image(self, value: dict, priority: int, *, generation: bool = False) -> None:
        if has_conflicting_id(value, self.image_id):
            return
        self.matched = True
        self.hidden = self.hidden or value.get("hideMeta") is True
        if not generation:
            creator = creator_name(value)
            if creator:
                self.put("creatorName", creator, priority)
        meta_sources = [item for item in (value.get("meta"), value.get("metadata")) if isinstance(item, dict)]
        sources = [value, *meta_sources]
        if not self.hidden:
            for source in sources:
                for output, aliases, limit in (
                        ("prompt", ("prompt", "Prompt"), 20000),
                        ("negativePrompt", ("negativePrompt", "NegativePrompt", "negative_prompt"), 10000)):
                    for alias in aliases:
                        if alias in source and isinstance(source[alias], str):
                            self.put(output, text(source[alias], limit), priority)
                            break
        resources = [source["resources"] for source in sources if isinstance(source.get("resources"), list)]
        if resources and not self.hidden:
            loras: list = []
            checkpoint = ""
            for resource_list in resources:
                for resource in resource_list[:2000]:
                    if not isinstance(resource, dict):
                        continue
                    if ("imageId" in resource and (not valid_id(resource["imageId"])
                                                  or str(resource["imageId"]) != self.image_id)):
                        continue
                    if resource.get("disabled") is True or resource.get("enabled") is False:
                        continue
                    model = resource.get("model") if isinstance(resource.get("model"), dict) else {}
                    version = resource.get("modelVersion") if isinstance(resource.get("modelVersion"), dict) else {}
                    resource_type = text(resource.get("type") or resource.get("modelType") or model.get("type")).lower()
                    names = [resource.get("modelName"), model.get("name"), resource.get("name"),
                             resource.get("versionName"), resource.get("modelVersionName"), version.get("name")]
                    if any(kind in resource_type for kind in ("lora", "locon", "dora")) or resource.get("isLora") is True:
                        strength = resource.get("strength")
                        if isinstance(strength, (int, float)) and not isinstance(strength, bool) and strength == 0:
                            continue
                        loras.extend(names)
                    elif resource_type == "checkpoint" and not checkpoint:
                        checkpoint = next((text(name, 300) for name in names if text(name, 300)), "")
            self.put("loras", unique_strings(loras), priority)
            if checkpoint:
                self.put("modelName", checkpoint, priority + 1)
        if not self.hidden:
            for source in sources:
                for alias in ("modelName", "Model"):
                    if isinstance(source.get(alias), str):
                        self.put("modelName", text(source[alias], 300), priority)
                        break
        if isinstance(value.get("loras"), list) and not self.hidden:
            self.put("loras", tag_names(value["loras"]), priority)
        if isinstance(value.get("tags"), list):
            self.put("tags", tag_names(value["tags"]), priority)
        if not generation and value.get("statsUnknown") is not True:
            reactions = page_reactions(value)
            for field in ("stats", "metrics", "reactionCounts", "reactions"):
                reactions.update(page_reactions(value.get(field)))
            if reactions:
                # Missing reaction keys are preserved from other exact records.
                self.put("reactions", reactions, priority)

    def post(self, value: dict) -> None:
        images = value.get("images")
        if not valid_id(value.get("id")) or not isinstance(images, list):
            return
        if not any(isinstance(image, dict) and explicit_id_matches(image, self.image_id) for image in images):
            return
        creator = creator_name(value)
        if creator:
            self.matched = True
            self.put("creatorName", creator, 0)

    def finish(self) -> dict:
        if self.hidden:
            for key in ("prompt", "negativePrompt", "modelName", "loras"):
                self.fields.pop(key, None)
                self.available.discard(key)
        fields = sorted(self.available)
        return {**self.fields, "availableFields": fields, "checkedFields": fields,
                "matchedImage": self.matched}


def parse_metadata(html: str, image_id: str) -> dict:
    """Return only observed metadata for image_id, with bounded parser work.

    availableFields/checkedFields include explicitly observed empty lists. A
    missing list is omitted: it does not mean this image used no LoRAs. Callers
    should merge nonempty metadata into missing catalog fields, not erase data.
    """
    if not valid_id(image_id):
        raise ValueError("Invalid image ID")
    if not isinstance(html, str) or len(html) > MAX_HTML_CHARS:
        raise ValueError("Page HTML exceeds the size limit")
    image_id = str(image_id)
    parser = JSONScripts()
    parser.feed(html)
    parser.close()
    result = Metadata(image_id)
    stack = [(document, "", 0) for document in parser.documents]
    nodes = 0
    while stack:
        value, context, depth = stack.pop()
        nodes += 1
        if nodes > MAX_NODES or depth > MAX_DEPTH:
            raise ValueError("Page JSON exceeds the structural limit")
        if isinstance(value, list):
            if len(value) > MAX_NODES - nodes:
                raise ValueError("Page JSON exceeds the structural limit")
            stack.extend((item, context, depth + 1) for item in reversed(value) if isinstance(item, (dict, list)))
        elif isinstance(value, dict):
            namespace, procedure, query_id = query_identity(value)
            if namespace and namespace not in ("image", "post"):
                # Model/profile query results can contain image-looking objects
                # and user fields that belong to a model author or viewer.
                continue
            if namespace == "image" and valid_id(query_id) and str(query_id) == image_id:
                payload = query_data(value)
                if isinstance(payload, dict):
                    if procedure == "getgenerationdata":
                        result.image(payload, 3, generation=True)
                    elif procedure in DETAIL_PROCEDURES:
                        result.image(payload, 2)
            if namespace == "post":
                payload = query_data(value)
                if isinstance(payload, dict):
                    result.post(payload)
            if looks_like_image(value, context) and explicit_id_matches(value, image_id):
                result.image(value, 1)
            # The uploader of a containing post is an allowed fallback; its
            # prompt, caption, resources, and reactions are not image metadata.
            if context.lower() in ("post", "posts"):
                result.post(value)
            stack.extend((item, key, depth + 1) for key, item in reversed(list(value.items()))
                         if isinstance(item, (dict, list)) and key.lower() not in EXCLUDED_BRANCHES
                         and key not in ("queryKey", "queryHash"))
    return result.finish()
