import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    SuggestModal,
} from "obsidian";

import stringSimilarity from "string-similarity";

interface ArxivPluginSettings {
    notesFolder: string;
}

const DEFAULT_SETTINGS: ArxivPluginSettings = {
    notesFolder: "",
};

function sanitizeTitleForSearch(title: string): string {
    return title
        .toLowerCase()
        .replace(/[-:,.]/g, ' ')  // Replace punctuation with spaces
        .replace(/\s+/g, ' ')     // Collapse multiple spaces
        .trim();
}

export default class ArxivPlugin extends Plugin {
    settings: ArxivPluginSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: "create-note-from-arxiv-clipboard",
            name: "Create Note from arXiv Clipboard",
            callback: () => this.createNoteFromClipboard(),
        });

        this.addSettingTab(new ArxivSettingTab(this.app, this));
    }

    async createNoteFromClipboard() {
        const clipboardText = await navigator.clipboard.readText();

        const arxivIdMatch = clipboardText.match(
            /arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/
        );
        const arxivId = arxivIdMatch ? arxivIdMatch[2] : null;

        if (arxivId) {
            // Directly fetch metadata by ID, no modal needed
            const metadata = await this.fetchArxivMetadata(arxivId);
            if (!metadata) {
                new Notice("Could not find metadata for the input.");
                return;
            }
            await this.createNoteFromMetadata(metadata);
            return;
        }

        // Open modal immediately with loading placeholder
        const loadingChoice = [
            { title: "Loading...", authors: [], year: 0, url: "" },
        ];
        const modal = new TitleSelectModal(this.app, loadingChoice, async (choice) => {
            if (!choice || !choice.title || choice.title === "Loading...") {
                new Notice("Cancelled or no selection.");
                return;
            }
            await this.createNoteFromMetadata(choice);
        });

        modal.open();

        // Fetch search results from arXiv and update modal choices
        const results = await this.searchArxivByTitle(clipboardText);
        if (!results || results.length === 0) {
            modal.updateChoices([
                { title: "No results found", authors: [], year: 0, url: "" },
            ]);
            return;
        }
        modal.updateChoices(results);
    }

    async createNoteFromMetadata(metadata: {
        title: string;
        authors: string[];
        year: number;
        url: string;
    }) {
        const filename = this.sanitizeFileName(metadata.title) + ".md";
        const folderPath = this.settings.notesFolder?.trim()
            ? this.settings.notesFolder.trim().replace(/\/$/, "") + "/"
            : "";
        const filePath = folderPath + filename;

        const fileExists = await this.app.vault.adapter.exists(filePath);
        if (fileExists) {
            const shouldOverwrite = await this.confirmOverwrite();
            if (!shouldOverwrite) return;
        }

        const content = this.formatNoteContent(metadata);

        try {
            if (fileExists) {
                const file = await this.app.vault.getAbstractFileByPath(filePath);
                await this.app.vault.modify(file, content);
            } else {
                await this.app.vault.create(filePath, content);
            }
            new Notice("Created arXiv note: " + filename);
        } catch (err) {
            new Notice("Error creating note: " + err);
        }
    }

    async fetchArxivMetadata(arxivId: string) {
        const response = await fetch(
            `https://export.arxiv.org/api/query?id_list=${arxivId}`
        );
        const text = await response.text();

        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "application/xml");
        const entry = xml.querySelector("entry");
        if (!entry) return null;

        const title =
            entry
                .querySelector("title")
                ?.textContent?.trim()
                .replace(/\s+/g, " ") || "";
        const authors = Array.from(entry.querySelectorAll("author > name")).map(
            (e) => e.textContent || ""
        );
        const published = entry.querySelector("published")?.textContent || "";
        const year = new Date(published).getFullYear();

        return {
            title,
            authors,
            year,
            url: `https://arxiv.org/abs/${arxivId}`,
        };
    }

    async searchArxivByTitle(title: string) {
        // Use title-only search with quotes for exact phrase matching
        const sanitized = sanitizeTitleForSearch(title);
        const query = encodeURIComponent(sanitized);

        const response = await fetch(
            `https://export.arxiv.org/api/query?search_query=ti:${query}&start=0&max_results=10`
        );
        const text = await response.text();

        const parser = new DOMParser();
        const xml = parser.parseFromString(text, "application/xml");
        const entries = Array.from(xml.querySelectorAll("entry"));

        if (entries.length === 0) return [];

        // Return array of metadata objects for modal to show
        return entries.map((entry) => {
            const t =
                entry
                    .querySelector("title")
                    ?.textContent?.trim()
                    .replace(/\s+/g, " ") || "";
            const authors = Array.from(entry.querySelectorAll("author > name")).map(
                (e) => e.textContent || ""
            );
            const published = entry.querySelector("published")?.textContent || "";
            const year = new Date(published).getFullYear();
            const id =
                entry.querySelector("id")?.textContent?.match(/\d{4}\.\d{4,5}/)?.[0] || "";

            return { title: t, authors, year, url: `https://arxiv.org/abs/${id}` };
        });
    }

    sanitizeFileName(title: string) {
        return title.replace(/:/g, " - ").replace(/[\\/:*?"<>|]/g, "");
    }

    formatNoteContent(metadata: {
        title: string;
        authors: string[];
        year: number;
        url: string;
    }) {
        return `---
title: "${metadata.title.replace(/:/g, " - ")}"
authors:
${metadata.authors.map((a) => `  - ${a}`).join("\n")}
year: ${metadata.year}
url: ${metadata.url}
contribution: 
tags: 
---`;
    }

    confirmOverwrite(): Promise<boolean> {
        return new Promise((resolve) => {
            new ConfirmOverwriteModal(this.app, (decision) => resolve(decision)).open();
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class TitleSelectModal extends SuggestModal<any> {
    choices: any[];
    onChoice: (choice: any | null) => void;

    constructor(app: App, choices: any[], onChoice: (choice: any | null) => void) {
        super(app);
        this.choices = choices;
        this.onChoice = onChoice;
    }

    updateChoices(newChoices: any[]) {
        this.choices = newChoices;
        this.onInput(); // refresh suggestions UI
    }

    getSuggestions(query: string) {
        if (!query) return this.choices;

        const normalizedQuery = sanitizeTitleForSearch(query);
        return this.choices
            .filter((c) => {
                const sim = stringSimilarity.compareTwoStrings(
                    sanitizeTitleForSearch(c.title),
                    normalizedQuery
                );
                return sim > 0.5;
            })
            .sort(
                (a, b) =>
                    stringSimilarity.compareTwoStrings(
                        sanitizeTitleForSearch(b.title),
                        normalizedQuery
                    ) -
                    stringSimilarity.compareTwoStrings(
                        sanitizeTitleForSearch(a.title),
                        normalizedQuery
                    )
            );
    }

    renderSuggestion(choice: any, el: HTMLElement) {
        el.createEl("div", { text: choice.title });
        if (choice.authors && choice.authors.length)
            el.createEl("small", { text: choice.authors.join(", ") });
    }

    onChooseSuggestion(item: any, evt: MouseEvent | KeyboardEvent) {
        this.onChoice(item);
    }

    onCancel() {
        this.onChoice(null);
    }
}

class ConfirmOverwriteModal extends Modal {
    onDecision: (overwrite: boolean) => void;

    constructor(app: App, onDecision: (overwrite: boolean) => void) {
        super(app);
        this.onDecision = onDecision;
    }

    onOpen() {
        const { contentEl, titleEl } = this;

        titleEl.setText("File Exists");

        contentEl.empty();
        contentEl.createEl("p", {
            text: "A note with this title already exists. Do you want to overwrite it?",
        });

        const buttonContainer = contentEl.createDiv({
            cls: "modal-button-container",
        });
        buttonContainer.style.display = "flex";
        buttonContainer.style.justifyContent = "flex-end";
        buttonContainer.style.gap = "10px";
        buttonContainer.style.marginTop = "30px";

        const overwriteButton = buttonContainer.createEl("button", {
            text: "Overwrite",
            cls: "mod-warning",
        });
        overwriteButton.onclick = () => {
            this.close();
            this.onDecision(true);
        };

        const cancelButton = buttonContainer.createEl("button", {
            text: "Cancel",
        });
        cancelButton.onclick = () => {
            this.close();
            this.onDecision(false);
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ArxivSettingTab extends PluginSettingTab {
    plugin: ArxivPlugin;

    constructor(app: App, plugin: ArxivPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "arXiv Note Plugin Settings" });

        new Setting(containerEl)
            .setName("Notes folder")
            .setDesc("Folder to save arXiv notes in")
            .addText((text) =>
                text
                    .setPlaceholder("Example: Literature/arXiv")
                    .setValue(this.plugin.settings.notesFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.notesFolder = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}