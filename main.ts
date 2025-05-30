import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    SuggestModal,
    requestUrl,
} from "obsidian";

import stringSimilarity from "string-similarity";

interface ArxivPluginSettings {
    notesFolder: string;
    downloadPDF: boolean;
    pdfFolder: string;
}

const DEFAULT_SETTINGS: ArxivPluginSettings = {
    notesFolder: "",
    downloadPDF: false,
    pdfFolder: "",
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
            const metadata = await this.fetchArxivMetadata(arxivId);
            if (!metadata) {
                new Notice("Could not find metadata for the input.");
                return;
            }
            await this.createNoteFromMetadata(metadata);
            return;
        }

        // Open modal with empty choices, but with "Loading..." placeholder
        const modal = new TitleSelectModal(this.app, [], async (choice) => {
            if (!choice || !choice.title || choice.title.startsWith("Search for")) {
                new Notice("Cancelled or no selection.");
                return;
            }
            await this.createNoteFromMetadata(choice);
        }, clipboardText);

        modal.setLoading(true); // NEW: tell modal it’s loading
        modal.open();

        // Fetch search results
        const results = await this.searchArxivByTitle(clipboardText);

        if (!results || results.length === 0) {
            modal.updateChoices([
                { title: "No results found", authors: [], year: 0, url: "" },
            ]);
        } else {
            modal.updateChoices(results);
        }
        modal.setLoading(false); // NEW: loading done
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

            // Open the newly created note
            const file = await this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                await this.app.workspace.getLeaf(true).openFile(file);
            }
        } catch (err) {
            new Notice("Error creating note: " + err);
        }
    }


    async downloadPdf(arxivUrl: string, savePath: string) {
        const idMatch = arxivUrl.match(/\/(\d{4}\.\d{4,5})(v\d+)?$/);
        if (!idMatch) throw new Error("Invalid arXiv ID");

        const arxivId = idMatch[1];
        const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;

        const response = await requestUrl({ url: pdfUrl });
        const buffer = response.arrayBuffer;

        if (!buffer) {
            throw new Error("Failed to download PDF content");
        }

        const uint8Array = new Uint8Array(buffer);
        await this.app.vault.adapter.writeBinary(savePath, uint8Array);
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
    loading: boolean = false;
    searchQuery: string;

    constructor(app: App, choices: any[], onChoice: (choice: any | null) => void, searchQuery: string) {
        super(app);
        this.choices = choices;
        this.onChoice = onChoice;
        this.searchQuery = searchQuery;
    }

    onOpen() {
        super.onOpen();
        this.setLoading(this.loading, this.searchQuery);
    }

    setLoading(isLoading: boolean, queryText?: string) {
        this.loading = isLoading;
        if (this.inputEl) {
            if (isLoading && queryText) {
                this.inputEl.placeholder = `Searching for "${queryText.trim()}"...`;
            } else {
                this.inputEl.placeholder = "Select...";
            }
        }
    }

    updateChoices(newChoices: any[]) {
        this.choices = newChoices;
        this.setLoading(false); // stop showing loading once results are in
        this.onInput(); // refresh suggestions UI
    }

    getSuggestions(query: string) {
        const normalizedQuery = sanitizeTitleForSearch(this.searchQuery);

        return this.choices
            .filter(choice => {
                const sim = stringSimilarity.compareTwoStrings(
                    sanitizeTitleForSearch(choice.title),
                    normalizedQuery
                );
                return sim > 0.5;
            })
            .sort((a, b) => {
                const simA = stringSimilarity.compareTwoStrings(
                    sanitizeTitleForSearch(a.title),
                    normalizedQuery
                );
                const simB = stringSimilarity.compareTwoStrings(
                    sanitizeTitleForSearch(b.title),
                    normalizedQuery
                );
                return simB - simA;
            });
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

        new Setting(containerEl)
            .setName("Download PDFs")
            .setDesc("Download PDF files for arXiv papers")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.downloadPDF)
                    .onChange(async (value) => {
                        this.plugin.settings.downloadPDF = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("PDF folder")
            .setDesc("Folder to save downloaded PDFs (relative to vault root)")
            .addText((text) =>
                text
                    .setPlaceholder("Example: Literature/arXiv/pdfs")
                    .setValue(this.plugin.settings.pdfFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.pdfFolder = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}