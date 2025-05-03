import { WanDialog } from "./dialog.js";
import { createElement as $el, empty, appendChildren, getClosestOrSelf, query, queryAll, setAttributes } from "./utils_dom.js";
import { logoCivitai, link, pencilColored, diskColored, dotdotdot } from "./svgs.js";
import { LORA_INFO_SERVICE } from "./model_info_service.js";
import { generateId, injectCss } from "./shared_utils.js";

// Simplified rgthree object for WanVideo
const rgthree = {
    showMessage: function(options) {
        // Simple toast message
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #333;
            color: white;
            padding: 12px 20px;
            border-radius: 4px;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        toast.textContent = options.message;
        document.body.appendChild(toast);

        setTimeout(() => {
            document.body.removeChild(toast);
        }, options.timeout || 3000);
    },
    isDevMode: () => false
};

class WanInfoDialog extends WanDialog {
    constructor(file) {
        const dialogOptions = {
            class: "rgthree-info-dialog",
            title: `<h2>Loading...</h2>`,
            content: "<center>Loading..</center>",
            onBeforeClose: () => {
                return true;
            },
        };
        super(dialogOptions);
        this.modifiedModelData = false;
        this.modelInfo = null;
        this.init(file);
    }
    async init(file) {
        var _a, _b;
        const cssPromise = this.injectCss("wan-dialog-model-info.css");
        this.modelInfo = await this.getModelInfo(file);
        await cssPromise;
        this.setContent(this.getInfoContent());
        this.setTitle(((_a = this.modelInfo) === null || _a === void 0 ? void 0 : _a["name"]) || ((_b = this.modelInfo) === null || _b === void 0 ? void 0 : _b["file"]) || "Unknown");
        this.attachEvents();
    }

    async injectCss(fileName) {
        const css = `
            /* Base dialog styling - exact rgthree colors */
            .wan-dialog {
                outline: 0;
                border: 0;
                border-radius: 6px;
                background: #414141;
                color: #fff;
                box-shadow: inset 1px 1px 0px rgba(255, 255, 255, 0.05), inset -1px -1px 0px rgba(0, 0, 0, 0.5), 2px 2px 20px rgb(0, 0, 0);
                max-width: 800px;
                box-sizing: border-box;
                font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
                font-size: 1rem;
                padding: 0;
                max-height: calc(100% - 32px);
            }
            .wan-dialog *, .wan-dialog *::before, .wan-dialog *::after {
                box-sizing: inherit;
            }
            .wan-dialog-container > * {
                padding: 8px 16px;
            }
            .wan-dialog-container > *:first-child {
                padding-top: 16px;
            }
            .wan-dialog-container > *:last-child {
                padding-bottom: 16px;
            }
            .wan-dialog-container-title h2 {
                font-size: 1.375rem;
                margin: 0;
                font-weight: bold;
                color: #fff;
            }
            .wan-dialog-container-content {
                overflow: auto;
                max-height: calc(100vh - 200px);
            }
            .wan-dialog-container-footer {
                display: flex;
                align-items: center;
                justify-content: center;
            }
            body.wan-dialog-open > *:not(.wan-dialog) {
                filter: blur(5px);
            }

            /* Info dialog specific styling - exact rgthree */
            .rgthree-info-dialog {
                width: 90vw;
                max-width: 960px;
            }
            .rgthree-info-dialog .rgthree-info-area {
                list-style: none;
                padding: 0;
                margin: 0;
                display: flex;
            }
            .rgthree-info-dialog .rgthree-info-area > li {
                display: inline-flex;
                margin: 0;
                vertical-align: top;
            }
            .rgthree-info-dialog .rgthree-info-area > li + li {
                margin-left: 6px;
            }
            .rgthree-info-dialog .rgthree-info-area > li:not(.-link) + li.-link {
                margin-left: auto;
            }
            .rgthree-info-dialog .rgthree-info-area > li.rgthree-info-tag > * {
                min-height: 24px;
                border-radius: 4px;
                line-height: 1;
                color: rgba(255, 255, 255, 0.85);
                background: rgb(69, 92, 85);
                font-size: 14px;
                font-weight: bold;
                text-decoration: none;
                display: flex;
                height: 1.6em;
                padding-left: 0.5em;
                padding-right: 0.5em;
                padding-bottom: 0.1em;
                align-content: center;
                justify-content: center;
                align-items: center;
                box-shadow: inset 0px 0px 0 1px rgba(0, 0, 0, 0.5);
            }
            .rgthree-info-dialog .rgthree-info-area > li.-type > * {
                background: rgb(73, 54, 94);
                color: rgb(228, 209, 248);
            }
            .rgthree-info-dialog .rgthree-info-area > li.rgthree-info-tag > * > svg {
                width: 16px;
                height: 16px;
            }
            .rgthree-info-dialog .rgthree-info-area > li.rgthree-info-tag > *:empty {
                display: none;
            }

            /* Table styling - exact rgthree */
            .rgthree-info-dialog .rgthree-info-table {
                border-collapse: collapse;
                margin: 16px 0px;
                width: 100%;
                font-size: 12px;
            }
            .rgthree-info-dialog .rgthree-info-table td {
                position: relative;
                border: 1px solid rgba(255, 255, 255, 0.25);
                padding: 0;
                vertical-align: top;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child {
                background: rgba(255, 255, 255, 0.075);
                width: 10px;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child > *:first-child {
                white-space: nowrap;
                padding-right: 32px;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child small {
                display: block;
                margin-top: 2px;
                opacity: 0.75;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child small > [data-action] {
                text-decoration: underline;
                cursor: pointer;
            }
            .rgthree-info-dialog .rgthree-info-table td:first-child small > [data-action]:hover {
                text-decoration: none;
            }
            .rgthree-info-dialog .rgthree-info-table td a,
            .rgthree-info-dialog .rgthree-info-table td a:hover,
            .rgthree-info-dialog .rgthree-info-table td a:visited {
                color: inherit;
            }
            .rgthree-info-dialog .rgthree-info-table td svg {
                width: 1.3333em;
                height: 1.3333em;
                vertical-align: -0.285em;
            }
            .rgthree-info-dialog .rgthree-info-table td svg.logo-civitai {
                margin-right: 0.3333em;
            }
            .rgthree-info-dialog .rgthree-info-table td > *:first-child {
                display: block;
                padding: 6px 10px;
            }
            .rgthree-info-dialog .rgthree-info-table td > input,
            .rgthree-info-dialog .rgthree-info-table td > textarea {
                padding: 5px 10px;
                border: 0;
                box-shadow: inset 1px 1px 5px 0px rgba(0, 0, 0, 0.5);
                font: inherit;
                appearance: none;
                background: #fff;
                color: #121212;
                resize: vertical;
                width: 100%;
            }
            .rgthree-info-dialog .rgthree-info-table tr[data-field-name=userNote] td > span:first-child {
                white-space: pre;
            }
            .rgthree-info-dialog .rgthree-info-table td .-help {
                border: 1px solid currentColor;
                position: absolute;
                right: 5px;
                top: 6px;
                line-height: 1;
                font-size: 11px;
                width: 12px;
                height: 12px;
                border-radius: 8px;
                display: flex;
                align-content: center;
                justify-content: center;
                cursor: help;
            }
            .rgthree-info-dialog .rgthree-info-table td .-help::before {
                content: "?";
            }

            /* Button styling - exact rgthree */
            .rgthree-button {
                --padding-top: 7px;
                --padding-bottom: 9px;
                --padding-x: 16px;
                position: relative;
                cursor: pointer;
                border: 0;
                border-radius: 0.25rem;
                background: rgba(0, 0, 0, 0.5);
                color: white;
                font-family: system-ui, sans-serif;
                font-size: 1rem;
                line-height: 1;
                white-space: nowrap;
                text-decoration: none;
                margin: 0.25rem;
                box-shadow: 0px 0px 2px rgb(0, 0, 0);
                background: #212121;
                transition: all 0.1s ease-in-out;
                padding: var(--padding-top) var(--padding-x) var(--padding-bottom);
                display: inline-flex;
                flex-direction: row;
                align-items: center;
                justify-content: center;
            }
            .rgthree-button::before, .rgthree-button::after {
                content: "";
                display: block;
                position: absolute;
                border-radius: 0.25rem;
                left: 0;
                top: 0;
                width: 100%;
                height: 100%;
                box-shadow: inset 1px 1px 0px rgba(255, 255, 255, 0.12), inset -1px -1px 0px rgba(0, 0, 0, 0.75);
                background: linear-gradient(to bottom, rgba(255, 255, 255, 0.06), rgba(0, 0, 0, 0.15));
                mix-blend-mode: screen;
            }
            .rgthree-button::after {
                mix-blend-mode: multiply;
            }
            .rgthree-button:hover {
                background: #303030;
            }
            .rgthree-button:active {
                box-shadow: 0px 0px 0px rgba(0, 0, 0, 0);
                background: #121212;
            }
            .rgthree-info-dialog .rgthree-info-table .rgthree-button[data-action=fetch-civitai] {
                font-size: inherit;
                padding: 6px 16px;
                margin: 2px;
            }

            /* Edit button styling */
            .rgthree-button-edit {
                background: none;
                border: none;
                cursor: pointer;
                padding: 4px;
                color: #fff;
                opacity: 0.7;
                display: flex;
                width: 28px;
                height: 28px;
                align-items: center;
                justify-content: center;
            }
            .rgthree-button-edit:hover {
                opacity: 1;
            }
            .rgthree-info-dialog .rgthree-info-table tr.editable button svg + svg {
                display: none;
            }
            .rgthree-info-dialog .rgthree-info-table tr.editable.-rgthree-editing button svg {
                display: none;
            }
            .rgthree-info-dialog .rgthree-info-table tr.editable.-rgthree-editing button svg + svg {
                display: inline-block;
            }

            /* Trained words styling - exact rgthree */
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list {
                list-style: none;
                padding: 2px 8px;
                margin: 0;
                display: flex;
                flex-direction: row;
                flex-wrap: wrap;
                max-height: 15vh;
                overflow: auto;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li {
                display: inline-flex;
                margin: 2px;
                vertical-align: top;
                border-radius: 4px;
                line-height: 1;
                color: rgba(255, 255, 255, 0.85);
                background: rgb(73, 91, 106);
                font-size: 1.2em;
                font-weight: 600;
                text-decoration: none;
                display: flex;
                height: 1.6em;
                align-content: center;
                justify-content: center;
                align-items: center;
                box-shadow: inset 0px 0px 0 1px rgba(0, 0, 0, 0.5);
                cursor: pointer;
                white-space: nowrap;
                max-width: 183px;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li:hover {
                background: rgb(68, 109, 142);
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li > svg {
                width: auto;
                height: 1.2em;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li > span {
                padding-left: 0.5em;
                padding-right: 0.5em;
                padding-bottom: 0.1em;
                text-overflow: ellipsis;
                overflow: hidden;
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li > small {
                align-self: stretch;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 0.5em;
                background: rgba(0, 0, 0, 0.2);
            }
            .rgthree-info-dialog .rgthree-info-table td > ul.rgthree-info-trained-words-list > li.-rgthree-is-selected {
                background: rgb(42, 126, 193);
            }

            /* Images styling - exact rgthree */
            .rgthree-info-dialog .rgthree-info-images {
                list-style: none;
                padding: 0;
                margin: 0;
                scroll-snap-type: x mandatory;
                display: flex;
                flex-direction: row;
                overflow: auto;
            }
            .rgthree-info-dialog .rgthree-info-images > li {
                scroll-snap-align: start;
                max-width: 90%;
                flex: 0 0 auto;
                display: flex;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                overflow: hidden;
                padding: 0;
                margin: 6px;
                font-size: 0;
                position: relative;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure {
                margin: 0;
                position: static;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure video,
            .rgthree-info-dialog .rgthree-info-images > li figure img {
                max-height: 45vh;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption {
                position: absolute;
                left: 0;
                width: 100%;
                bottom: 0;
                padding: 12px;
                font-size: 12px;
                background: rgba(0, 0, 0, 0.85);
                opacity: 0;
                transform: translateY(50px);
                transition: all 0.25s ease-in-out;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span {
                display: inline-block;
                padding: 2px 4px;
                margin: 2px;
                border-radius: 2px;
                border: 1px solid rgba(255, 255, 255, 0.2);
                word-break: break-word;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span label {
                display: inline;
                padding: 0;
                margin: 0;
                opacity: 0.5;
                pointer-events: none;
                user-select: none;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span a {
                color: inherit;
                text-decoration: underline;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span a:hover {
                text-decoration: none;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption > span a svg {
                height: 10px;
                margin-left: 4px;
                fill: currentColor;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption:empty {
                text-align: center;
            }
            .rgthree-info-dialog .rgthree-info-images > li figure figcaption:empty::before {
                content: "No data.";
            }
            .rgthree-info-dialog .rgthree-info-images > li:hover figure figcaption {
                opacity: 1;
                transform: translateY(0px);
            }
        `;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return Promise.resolve();
    }

    getCloseEventDetail() {
        const detail = {
            dirty: this.modifiedModelData,
        };
        return { detail };
    }

    attachEvents() {
        this.contentElement.addEventListener("click", async (e) => {
            const target = getClosestOrSelf(e.target, "[data-action]");
            const action = target === null || target === void 0 ? void 0 : target.getAttribute("data-action");
            if (!target || !action) {
                return;
            }
            await this.handleEventAction(action, target, e);
        });
    }

    async handleEventAction(action, target, e) {
        var _a, _b;
        const info = this.modelInfo;
        if (!(info === null || info === void 0 ? void 0 : info.file)) {
            return;
        }
        if (action === "fetch-civitai") {
            this.modelInfo = await this.refreshModelInfo(info.file);
            this.setContent(this.getInfoContent());
            this.setTitle(((_a = this.modelInfo) === null || _a === void 0 ? void 0 : _a["name"]) || ((_b = this.modelInfo) === null || _b === void 0 ? void 0 : _b["file"]) || "Unknown");
        }
        else if (action === "copy-trained-words") {
            const selected = queryAll(".-rgthree-is-selected", target.closest("tr"));
            const text = selected.map((el) => el.getAttribute("data-word")).join(", ");
            await navigator.clipboard.writeText(text);
            rgthree.showMessage({
                id: "copy-trained-words-" + generateId(4),
                type: "success",
                message: `Successfully copied ${selected.length} key word${selected.length === 1 ? "" : "s"}.`,
                timeout: 4000,
            });
        }
        else if (action === "toggle-trained-word") {
            target === null || target === void 0 ? void 0 : target.classList.toggle("-rgthree-is-selected");
            const tr = target.closest("tr");
            if (tr) {
                const span = query("td:first-child > *", tr);
                let small = query("small", span);
                if (!small) {
                    small = $el("small", { parent: span });
                }
                const num = queryAll(".-rgthree-is-selected", tr).length;
                small.innerHTML = num
                    ? `${num} selected | <span role="button" data-action="copy-trained-words">Copy</span>`
                    : "";
            }
        }
        else if (action === "edit-row") {
            const tr = target.closest("tr");
            const td = query("td:nth-child(2)", tr);
            const input = td.querySelector("input,textarea");
            if (!input) {
                const fieldName = tr.dataset["fieldName"];
                tr.classList.add("-rgthree-editing");
                const isTextarea = fieldName === "userNote";
                const input = $el(`${isTextarea ? "textarea" : 'input[type="text"]'}`, {
                    value: td.textContent,
                });
                input.addEventListener("keydown", (e) => {
                    if (!isTextarea && e.key === "Enter") {
                        const modified = saveEditableRow(info, tr, true);
                        this.modifiedModelData = this.modifiedModelData || modified;
                        e.stopPropagation();
                        e.preventDefault();
                    }
                    else if (e.key === "Escape") {
                        const modified = saveEditableRow(info, tr, false);
                        this.modifiedModelData = this.modifiedModelData || modified;
                        e.stopPropagation();
                        e.preventDefault();
                    }
                });
                appendChildren(empty(td), [input]);
                input.focus();
            }
            else if (target.nodeName.toLowerCase() === "button") {
                const modified = saveEditableRow(info, tr, true);
                this.modifiedModelData = this.modifiedModelData || modified;
            }
            e === null || e === void 0 ? void 0 : e.preventDefault();
            e === null || e === void 0 ? void 0 : e.stopPropagation();
        }
    }

    getInfoContent() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
        const info = this.modelInfo || {};
        const civitaiLink = (_a = info.links) === null || _a === void 0 ? void 0 : _a.find((i) => i.includes("civitai.com/models"));
        const html = `
      <ul class="rgthree-info-area">
        <li title="Type" class="rgthree-info-tag -type -type-${(info.type || "").toLowerCase()}"><span>${info.type || ""}</span></li>
        <li title="Base Model" class="rgthree-info-tag -basemodel -basemodel-${(info.baseModel || "").toLowerCase()}"><span>${info.baseModel || ""}</span></li>
        <li class="rgthree-info-menu" stub="menu"></li>
        ${""}
      </ul>

      <table class="rgthree-info-table">
        ${infoTableRow("File", info.file || "")}
        ${infoTableRow("Hash (sha256)", info.sha256 || "")}
        ${civitaiLink
            ? infoTableRow("Civitai", `<a href="${civitaiLink}" target="_blank">${logoCivitai}View on Civitai</a>`)
            : ((_c = (_b = info.raw) === null || _b === void 0 ? void 0 : _b.civitai) === null || _c === void 0 ? void 0 : _c.error) === "Model not found"
                ? infoTableRow("Civitai", '<i>Model not found</i> <span class="-help" title="The model was not found on civitai with the sha256 hash. It\'s possible the model was removed, re-uploaded, or was never on civitai to begin with."></span>')
                : ((_e = (_d = info.raw) === null || _d === void 0 ? void 0 : _d.civitai) === null || _e === void 0 ? void 0 : _e.error)
                    ? infoTableRow("Civitai", (_g = (_f = info.raw) === null || _f === void 0 ? void 0 : _f.civitai) === null || _g === void 0 ? void 0 : _g.error)
                    : !((_h = info.raw) === null || _h === void 0 ? void 0 : _h.civitai)
                        ? infoTableRow("Civitai", `<button class="rgthree-button" data-action="fetch-civitai">Fetch info from civitai</button>`)
                        : ""}

        ${infoTableRow("Name", info.name || ((_k = (_j = info.raw) === null || _j === void 0 ? void 0 : _j.metadata) === null || _k === void 0 ? void 0 : _k.ss_output_name) || "", "The name for display.", "name")}

        ${!info.baseModelFile && !info.baseModelFile
            ? ""
            : infoTableRow("Base Model", (info.baseModel || "") + (info.baseModelFile ? ` (${info.baseModelFile})` : ""))}


        ${!((_l = info.trainedWords) === null || _l === void 0 ? void 0 : _l.length)
            ? ""
            : infoTableRow("Trained Words", (_m = getTrainedWordsMarkup(info.trainedWords)) !== null && _m !== void 0 ? _m : "", "Trained words from the metadata and/or civitai. Click to select for copy.")}

        ${!((_p = (_o = info.raw) === null || _o === void 0 ? void 0 : _o.metadata) === null || _p === void 0 ? void 0 : _p.ss_clip_skip) || ((_r = (_q = info.raw) === null || _q === void 0 ? void 0 : _q.metadata) === null || _r === void 0 ? void 0 : _r.ss_clip_skip) == "None"
            ? ""
            : infoTableRow("Clip Skip", (_t = (_s = info.raw) === null || _s === void 0 ? void 0 : _s.metadata) === null || _t === void 0 ? void 0 : _t.ss_clip_skip)}
        ${infoTableRow("Strength Min", (_u = info.strengthMin) !== null && _u !== void 0 ? _u : "", "The recommended minimum strength, In the Power Lora Loader node, strength will signal when it is below this threshold.", "strengthMin")}
        ${infoTableRow("Strength Max", (_v = info.strengthMax) !== null && _v !== void 0 ? _v : "", "The recommended maximum strength. In the Power Lora Loader node, strength will signal when it is above this threshold.", "strengthMax")}
        ${""}
        ${infoTableRow("Additional Notes", (_w = info.userNote) !== null && _w !== void 0 ? _w : "", "Additional notes you'd like to keep and reference in the info dialog.", "userNote")}

      </table>

      <ul class="rgthree-info-images">${(_y = (_x = info.images) === null || _x === void 0 ? void 0 : _x.map((img) => `
        <li>
          <figure>${img.type === 'video'
            ? `<video src="${img.url}" autoplay loop></video>`
            : `<img src="${img.url}" />`}
            <figcaption><!--
              -->${imgInfoField("", img.civitaiUrl
            ? `<a href="${img.civitaiUrl}" target="_blank">civitai${link}</a>`
            : undefined)}<!--
              -->${imgInfoField("seed", img.seed)}<!--
              -->${imgInfoField("steps", img.steps)}<!--
              -->${imgInfoField("cfg", img.cfg)}<!--
              -->${imgInfoField("sampler", img.sampler)}<!--
              -->${imgInfoField("model", img.model)}<!--
              -->${imgInfoField("positive", img.positive)}<!--
              -->${imgInfoField("negative", img.negative)}<!--
            --><!--${""}--></figcaption>
          </figure>
        </li>`).join("")) !== null && _y !== void 0 ? _y : ""}</ul>
    `;
        const div = $el("div", { html });
        if (rgthree.isDevMode()) {
            setAttributes(query('[stub="menu"]', div), {
                children: [
                    // Menu button functionality would go here
                ],
            });
        }
        return div;
    }
}

export class WanLoraInfoDialog extends WanInfoDialog {
    async getModelInfo(file) {
        return LORA_INFO_SERVICE.getInfo(file, false, false);
    }
    async refreshModelInfo(file) {
        return LORA_INFO_SERVICE.refreshInfo(file);
    }
    async clearModelInfo(file) {
        return LORA_INFO_SERVICE.clearFetchedInfo(file);
    }
}

function infoTableRow(name, value, help = "", editableFieldName = "") {
    return `
    <tr class="${editableFieldName ? "editable" : ""}" ${editableFieldName ? `data-field-name="${editableFieldName}"` : ""}>
      <td><span>${name} ${help ? `<span class="-help" title="${help}">ℹ️</span>` : ""}<span></td>
      <td ${editableFieldName ? "" : 'colspan="2"'}>${String(value).startsWith("<") ? value : `<span>${value}<span>`}</td>
      ${editableFieldName
        ? `<td style="width: 24px;"><button class="rgthree-button-edit" data-action="edit-row">${pencilColored}${diskColored}</button></td>`
        : ""}
    </tr>`;
}

function getTrainedWordsMarkup(words) {
    let markup = `<ul class="rgthree-info-trained-words-list">`;
    for (const wordData of words || []) {
        markup += `<li title="${wordData.word}" data-word="${wordData.word}" class="rgthree-info-trained-words-list-item" data-action="toggle-trained-word">
      <span>${wordData.word}</span>
      ${wordData.civitai ? logoCivitai : ""}
      ${wordData.count != null ? `<small>${wordData.count}</small>` : ""}
    </li>`;
    }
    markup += `</ul>`;
    return markup;
}

function saveEditableRow(info, tr, saving = true) {
    var _a;
    const fieldName = tr.dataset["fieldName"];
    const input = query("input,textarea", tr);
    let newValue = (_a = info[fieldName]) !== null && _a !== void 0 ? _a : "";
    let modified = false;
    if (saving) {
        newValue = input.value;
        if (fieldName.startsWith("strength")) {
            if (Number.isNaN(Number(newValue))) {
                alert(`You must enter a number into the ${fieldName} field.`);
                return false;
            }
            newValue = (Math.round(Number(newValue) * 100) / 100).toFixed(2);
        }
        LORA_INFO_SERVICE.savePartialInfo(info.file, { [fieldName]: newValue });
        modified = true;
    }
    tr.classList.remove("-rgthree-editing");
    const td = query("td:nth-child(2)", tr);
    appendChildren(empty(td), [$el("span", { text: newValue })]);
    return modified;
}

function imgInfoField(label, value) {
    return value != null ? `<span>${label ? `<label>${label} </label>` : ""}${value}</span>` : "";
}