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

interface Settings {
    notesFolder: string;
    downloadPDF: boolean;
    pdfFolder: string;
}

const DEFAULT_SETTINGS: Settings = {
    notesFolder: "",
    downloadPDF: false,
    pdfFolder: "",
};

function sanitizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[-:,.]/g, ' ')  // Replace punctuation with spaces
        .replace(/\s+/g, ' ')     // Collapse multiple spaces
        .trim();
}

export default class PapersPlugin extends Plugin {
    settings: Settings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: "import-from-clipboard",
            name: "Import from Clipboard",
            callback: () => this.createNoteFromClipboard(),
        });

        this.addCommand({
            id: "import-paper",
            name: "Import Paper",
            callback: () => this.showImportModal(),
        });

        this.addSettingTab(new PapersSettingTab(this.app, this));
    }

    showImportModal() {
        const modal = new ImportModal(this.app, async (input: string) => {
            if (!input?.trim()) {
                new Notice("No input provided.");
                return;
            }
            await this.processInput(input.trim());
        });
        modal.open();
    }

    async createNoteFromClipboard() {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText?.trim()) {
            new Notice("Clipboard is empty.");
            return;
        }
        await this.processInput(clipboardText.trim());
    }

    async processInput(input: string) {
        // Check if input contains an arXiv URL
        const arxivIdMatch = input.match(
            /arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/
        );
        const arxivId = arxivIdMatch ? arxivIdMatch[2] : null;

        if (arxivId) {
            const metadata = await this.fetchArxivMetadata(arxivId);
            if (!metadata) {
                new Notice("Could not find metadata for the arXiv paper.");
                return;
            }
            await this.createNoteFromMetadata(metadata);
            return;
        }

        // Otherwise, search by title
        const modal = new TitleSelectModal(this.app, [], async (choice) => {
            if (!choice || !choice.title || choice.title.startsWith("Search for")) {
                new Notice("Cancelled or no selection.");
                return;
            }
            await this.createNoteFromMetadata(choice);
        }, input);

        modal.setLoading(true);
        modal.open();

        const results = await this.searchArxivByTitle(input);

        if (!results || results.length === 0) {
            modal.updateChoices([
                { title: "No results found", authors: [], year: 0, url: "" },
            ]);
        } else {
            modal.updateChoices(results);
        }
        modal.setLoading(false);
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
        const sanitized = sanitizeTitle(title);
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

class ImportModal extends Modal {
    onSubmit: (input: string) => void;
    inputEl: HTMLInputElement;

    constructor(app: App, onSubmit: (input: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl, titleEl } = this;

        titleEl.setText("Import Paper");

        contentEl.empty();

        contentEl.createEl("p", {
            text: "Enter a paper title to search arXiv, or paste an arXiv URL for direct import."
        });

        this.inputEl = contentEl.createEl("input", {
            type: "text",
            placeholder: "Enter paper title or arXiv URL..."
        });

        // Make input span full width
        this.inputEl.style.width = "100%";
        this.inputEl.style.boxSizing = "border-box";

        // Focus the input
        setTimeout(() => this.inputEl.focus(), 10);

        // Handle enter key with proper event handling
        this.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                this.submit();
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.close();
            }
        });

        const buttonContainer = contentEl.createDiv({
            cls: "modal-button-container",
        });

        const importButton = buttonContainer.createEl("button", {
            text: "Import",
            cls: "mod-cta",
        });
        importButton.onclick = () => this.submit();

        const cancelButton = buttonContainer.createEl("button", {
            text: "Cancel",
        });
        cancelButton.onclick = () => this.close();
    }

    submit() {
        const value = this.inputEl.value.trim();
        if (value) {
            this.close();
            this.onSubmit(value);
        }
    }

    onClose() {
        this.contentEl.empty();
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
        this.emptyStateText = "No results found";
    }

    onOpen() {
        super.onOpen();
        this.setLoading(this.loading, this.searchQuery);
    }

    setLoading(isLoading: boolean, queryText?: string) {
        this.loading = isLoading;
        if (this.inputEl) {
            this.inputEl.placeholder = "Select a paper...";
            this.inputEl.disabled = isLoading;
        }
        
        if (isLoading && queryText) {
            this.emptyStateText = `Searching for "${queryText.trim()}"...`;
        } else {
            this.emptyStateText = "No results found";
        }
        
        // Trigger a re-render
        this.onInput();
    }

    updateChoices(newChoices: any[]) {
        this.choices = newChoices;
        this.setLoading(false);
        this.onInput();
    }

    getSuggestions(query: string) {
        // If loading, return empty array to show loading message via emptyStateText
        if (this.loading) {
            return [];
        }

        const normalizedQuery = sanitizeTitle(this.searchQuery);

        return this.choices
            .filter(choice => {
                const sim = stringSimilarity.compareTwoStrings(
                    sanitizeTitle(choice.title),
                    normalizedQuery
                );
                return sim > 0.5;
            })
            .sort((a, b) => {
                const simA = stringSimilarity.compareTwoStrings(
                    sanitizeTitle(a.title),
                    normalizedQuery
                );
                const simB = stringSimilarity.compareTwoStrings(
                    sanitizeTitle(b.title),
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
            text: "A note with this title already exists. Do you want to overwrite?",
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

class PapersSettingTab extends PluginSettingTab {
    plugin: PapersPlugin;

    constructor(app: App, plugin: PapersPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Notes folder")
            .setDesc("Folder to save paper notes in")
            .addText((text) =>
                text
                    .setPlaceholder("Example: Research/Papers")
                    .setValue(this.plugin.settings.notesFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.notesFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Download PDF")
            .setDesc("Download paper PDF files")
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
            .setDesc("Folder to save downloaded PDFs")
            .addText((text) =>
                text
                    .setPlaceholder("Example: Research/PDF")
                    .setValue(this.plugin.settings.pdfFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.pdfFolder = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}