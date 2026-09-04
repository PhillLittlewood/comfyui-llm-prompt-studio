import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

const NODE_NAME = "LLMPromptStudio";
// Both draw whatever the run sent back: the count alone for the simple one,
// the count plus the text it counted for the other.
const PREVIEW_NODES = new Set(["LLMTextTokenPreview", "LLMTokenCount"]);
let TEMPLATES = {};

async function loadTemplates() {
    if (Object.keys(TEMPLATES).length) return TEMPLATES;
    try {
        const r = await api.fetchApi("/llm_prompt_studio/templates");
        TEMPLATES = await r.json();
    } catch (e) {
        console.warn("[coco] could not load templates:", e);
    }
    return TEMPLATES;
}

function getWidget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

// A widget the node draws but never sends. TWO flags are needed, because the
// frontend reads a different one on each path:
//   - the workflow serializer skips `widget.serialize === false` (widgets_values);
//   - graphToPrompt, which builds what the backend runs, skips only
//     `widget.options.serialize === false`.
// Setting just the first one leaves the widget in the prompt's `inputs`, and the
// backend hashes EVERY key of `inputs` into the execution cache signature
// (comfy_execution/caching.py). `generated_text` holds a different prompt after
// every run, so the node's signature changed on every queue and the LLM was
// called again - a fixed seed could not cache it. Set both, always.
function dontSerialize(w) {
    if (!w) return w;
    w.serialize = false;
    w.options = w.options || {};
    w.options.serialize = false;
    return w;
}

// ------------------------------------------------------------- model picker
// The `model` field stays a free-text STRING on the backend: a saved workflow
// may name a model the server is not serving right now, and an empty value is
// the documented "use whatever is loaded" mode. So the dropdown does not
// replace the field - it writes into it. That also keeps it out of
// widgets_values, whose save path indexes by widget position while its load
// path compacts over the serialized ones: a picker inserted among the real
// widgets would shift every saved workflow by a slot.
const PICKER_NAME = "📋 Models on the server";
const PICK_AUTO = "(auto) use the model loaded at the address";
const PICK_EMPTY = "(press Detect / refresh to list them)";

async function fetchModels(node) {
    const base = getWidget(node, "base_url")?.value || "http://localhost:1234/v1";
    const key = getWidget(node, "api_key")?.value || "";
    const url =
        "/llm_prompt_studio/models?base_url=" +
        encodeURIComponent(base) +
        "&api_key=" +
        encodeURIComponent(key);
    try {
        const r = await api.fetchApi(url);
        const data = await r.json();
        return { base, ...data };
    } catch (e) {
        console.error("[coco] model list failed:", e);
        return { base, models: [], suggested: null, error: String(e) };
    }
}

// Fill the dropdown with what the address answered. A dead address leaves one
// entry saying so, rather than an empty list that looks like a broken widget.
function fillPicker(node, data) {
    const w = getWidget(node, PICKER_NAME);
    if (!w) return;
    const served = Array.isArray(data?.models) ? data.models : [];
    const cur = (getWidget(node, "model")?.value || "").trim();
    if (!served.length) {
        // Say the address answered nothing instead of showing an empty list,
        // which reads as a broken widget.
        w._models = new Set();
        w.options.values = ["(no model listed at " + data.base + ")"];
        w.value = w.options.values[0];
        console.warn("[coco] no model at", data.base, data?.error || "");
    } else {
        // A forced name the server is not serving right now still has to show
        // as the current pick, otherwise the dropdown claims 'auto' while the
        // field says otherwise.
        const all = served.includes(cur) || !cur ? served : [...served, cur];
        w._models = new Set(all);
        w.options.values = [PICK_AUTO, ...all];
        w.value = cur && w._models.has(cur) ? cur : PICK_AUTO;
    }
    app.graph.setDirtyCanvas(true, true);
}

// Refresh the list, and - only when asked - drop the detected chat model into
// the text field. Text-encoder / embedding models are skipped server-side.
async function detectModel(node, fillField = true) {
    const data = await fetchModels(node);
    fillPicker(node, data);
    if (!fillField) return;
    const modelW = getWidget(node, "model");
    const pick = data.suggested || (data.models && data.models[0]);
    if (modelW && pick) {
        modelW.value = pick;
        const w = getWidget(node, PICKER_NAME);
        if (w && w._models?.has(pick)) w.value = pick;
        app.graph.setDirtyCanvas(true, true);
    }
}

// ------------------------------------------------------------- resizable boxes
// ComfyUI pins .comfy-multiline-input to `resize: none` AND recomputes the
// textarea height from the widget layout on every redraw, so showing the
// browser's handle is only half the job: without the second half the next
// redraw undoes the drag. options.getMinHeight/getMaxHeight are what a DOM
// widget's computeLayoutSize reads, so feeding the dragged height back through
// them is what makes the new size stick - and grows the node instead of
// overflowing it.
//
// The reserved height is NOT the height of the textarea: the frontend draws the
// widget's box at `computedHeight - 2 * margin` and stretches the element to
// fill it (h-full). Reporting the raw dragged height therefore leaves the
// element 2 * margin taller than the box it sits in, and that overflow is
// exactly what covered the widgets underneath.
const MIN_BOX_HEIGHT = 60;
const DEFAULT_WIDGET_MARGIN = 10;

// Heights live in node.properties, which litegraph serializes on its own.
// Never widgets_values: that array is positional, and one extra entry would
// shift every saved workflow by a slot.
function boxHeights(node) {
    if (!node.properties) node.properties = {};
    if (!node.properties.boxHeights) node.properties.boxHeights = {};
    return node.properties.boxHeights;
}

function makeResizable(node, w) {
    try {
        // .element is the textarea itself (no wrapper); .inputEl is its
        // deprecated alias, kept only for older frontends.
        const el = w?.element || w?.inputEl;
        if (!el || el.tagName !== "TEXTAREA" || el.dataset.cocoResize) return;
        el.dataset.cocoResize = "1";
        el.style.resize = "vertical";
        el.style.overflowY = "auto";
        el.style.minHeight = MIN_BOX_HEIGHT + "px";

        // A DOM widget is laid out through computeLayoutSize, which reads these
        // two options; a legacy canvas widget goes through computeSize instead.
        // Only ever answer once the user has actually dragged: claiming a height
        // before that takes the box out of the frontend's own distribution and
        // the node ends up shorter than its widgets - they then overlap whatever
        // sits below. Hence the `|| fall through` in every branch.
        w.options = w.options || {};
        const origMin = w.options.getMinHeight?.bind(w.options);
        const origMax = w.options.getMaxHeight?.bind(w.options);
        // _cocoBox = what the layout must reserve (margins included);
        // _cocoHeight = the textarea itself, for the legacy canvas path, which
        // has no margin to account for.
        w.options.getMinHeight = () => w._cocoBox || origMin?.();
        w.options.getMaxHeight = () => w._cocoBox || origMax?.();
        if (typeof w.computeSize === "function") {
            const origSize = w.computeSize.bind(w);
            w.computeSize = (width) =>
                w._cocoHeight ? [width, w._cocoHeight] : origSize(width);
        }

        // Grow the NODE by exactly what the box gained: asking for its computed
        // minimum instead would shrink a node the user had made taller. The
        // relayout resizes the element right back, firing the observer again -
        // comparing against the last height we caused stops the loop.
        const margin = typeof w.margin === "number" ? w.margin : DEFAULT_WIDGET_MARGIN;
        let last = Math.round(el.offsetHeight);
        new ResizeObserver(() => {
            const h = Math.max(MIN_BOX_HEIGHT, Math.round(el.offsetHeight));
            if (!h || Math.abs(h - last) < 2) return;
            const delta = h - last;
            last = h;
            // + the two margins the frontend subtracts again when it draws the
            // box, so the box ends up exactly as tall as the textarea.
            w._cocoHeight = h;
            w._cocoBox = h + 2 * margin;
            boxHeights(node)[w.name] = h;
            node.setSize([node.size[0], node.size[1] + delta]);
            app.graph.setDirtyCanvas(true, true);
        }).observe(el);

        // Restoring a saved height goes through the same path: setting the style
        // fires the observer, which applies the delta to the node.
        const saved = boxHeights(node)[w.name];
        if (saved && Math.abs(saved - last) >= 2) el.style.height = saved + "px";
    } catch (e) {
        console.warn("[coco] could not make", w?.name, "resizable:", e);
    }
}

// Every multiline box of the node, including ones added later (generated_text).
function makeAllResizable(node) {
    for (const w of node.widgets || []) makeResizable(node, w);
}

// A display-only text box added at run time. Never serialized: widgets_values is
// positional, so one extra entry there would shift every saved workflow by a
// slot - and the prompt's `inputs` feed the execution cache, so a box holding
// the last run's text would invalidate the node on every queue.
function readonlyBox(node, name) {
    let w = node.widgets?.find((x) => x.name === name);
    if (!w) {
        w = ComfyWidgets["STRING"](
            node,
            name,
            ["STRING", { multiline: true }],
            app
        ).widget;
        dontSerialize(w);
        const el = w.element || w.inputEl;
        if (el) {
            el.readOnly = true;
            el.style.opacity = "0.85";
        }
    }
    return w;
}

app.registerExtension({
    name: "comfy.LLMPromptStudio",
    async setup() {
        await loadTemplates();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (PREVIEW_NODES.has(nodeData.name)) {
            // Token count first, then the text it counted. Both boxes are
            // rebuilt from the run's result, never from widgets_values.
            const onExec = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExec?.apply(this, arguments);
                const node = this;
                const join = (v) =>
                    v === undefined || v === null
                        ? null
                        : Array.isArray(v)
                        ? v.join("")
                        : String(v);

                const info = join(message?.info);
                if (info !== null) {
                    const w = readonlyBox(node, "token_count");
                    w.value = info;
                    const el = w.element || w.inputEl;
                    // Over budget is the one thing worth spotting without reading.
                    if (el) el.style.color = info.includes("OVER") ? "#ff6b6b" : "";
                    makeResizable(node, w);
                }

                const text = join(message?.text);
                if (text !== null) {
                    const w = readonlyBox(node, "preview_text");
                    w.value = text;
                    makeResizable(node, w);
                }
                app.graph.setDirtyCanvas(true, true);
            };

            // A saved workflow reopens with the boxes gone (serialize:false), so
            // the node must not keep the height they had reserved.
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const r = onConfigure?.apply(this, arguments);
                setTimeout(() => makeAllResizable(this), 250);
                return r;
            };
            return;
        }

        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const ret = onNodeCreated?.apply(this, arguments);
            const node = this;

            // Pick a model instead of typing its name. Appended (never spliced
            // among the real widgets) and never serialized - see dontSerialize.
            const picker = node.addWidget(
                "combo",
                PICKER_NAME,
                PICK_EMPTY,
                (v) => {
                    const modelW = getWidget(node, "model");
                    if (!modelW) return;
                    if (v === PICK_AUTO) modelW.value = "";
                    else if (picker._models?.has(v)) modelW.value = v;
                    app.graph.setDirtyCanvas(true, true);
                },
                { values: [PICK_EMPTY], serialize: false }
            );
            dontSerialize(picker);

            // Optional: detect & show which model will be used (field can stay empty).
            const detectBtn = node.addWidget(
                "button",
                "🔄 Detect model / refresh the list",
                null,
                () => detectModel(node)
            );
            dontSerialize(detectBtn);

            // Pointing at another server must not keep offering the old list.
            for (const name of ["base_url", "api_key"]) {
                const w = getWidget(node, name);
                if (!w) continue;
                const orig = w.callback;
                w.callback = function () {
                    const r = orig?.apply(this, arguments);
                    detectModel(node, false);
                    return r;
                };
            }

            const applyTemplate = async () => {
                await loadTemplates();
                const tw = getWidget(node, "target_model");
                const sw = getWidget(node, "system_prompt");
                if (!tw || !sw) return;
                const t = TEMPLATES[tw.value];
                if (t != null) {
                    sw.value = t;
                    app.graph.setDirtyCanvas(true, true);
                }
            };

            const presetBtn = node.addWidget(
                "button",
                "📥 Load preset prompt",
                null,
                applyTemplate
            );
            dontSerialize(presetBtn);

            // Auto-load the matching preset into the system prompt box on change.
            const tw = getWidget(node, "target_model");
            if (tw) {
                const origCb = tw.callback;
                tw.callback = function () {
                    const r = origCb?.apply(this, arguments);
                    applyTemplate();
                    return r;
                };
            }

            // On a brand-new node: pre-fill the preset and show the detected model.
            // Never clobber a saved/edited value, and never write error text into
            // the model field (it stays empty -> auto-detected at run time).
            setTimeout(() => {
                const sw = getWidget(node, "system_prompt");
                if (sw && (!sw.value || !sw.value.trim())) applyTemplate();
                // Always list what the address serves; only fill the empty
                // field on a brand-new node, never clobber a saved value.
                const mw = getWidget(node, "model");
                detectModel(node, !(mw && mw.value && mw.value.trim()));
                // After configure(), so a saved workflow's box heights are back.
                makeAllResizable(node);
            }, 250);

            return ret;
        };

        // Show the generated prompt (cleaned, no thinking) on the node itself.
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const node = this;
            const text = message?.text;
            if (text === undefined || text === null) return;
            const value = Array.isArray(text) ? text.join("") : String(text);

            let w = node.widgets?.find((x) => x.name === "generated_text");
            if (!w) {
                w = ComfyWidgets["STRING"](
                    node,
                    "generated_text",
                    ["STRING", { multiline: true }],
                    app
                ).widget;
                dontSerialize(w); // preview only: saved nowhere, sent nowhere
                if (w.inputEl) {
                    w.inputEl.readOnly = true;
                    w.inputEl.style.opacity = "0.85";
                }
            }
            w.value = value;
            makeResizable(node, w);
            app.graph.setDirtyCanvas(true, true);
        };
    },
});
