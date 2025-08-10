import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    SuggestModal,
    TFile,
    requestUrl,
} from "obsidian";

import compareTwoStrings from 'string-similarity-js';

interface Settings {
    notesFolder: string;
    pdfFolder: string;
    noteTemplate: string;
}

const DEFAULT_SETTINGS: Settings = {
    notesFolder: "",
    pdfFolder: "",
    noteTemplate: `---
title: "{{TITLE}}"
authors:
{{AUTHORS}}
year: {{YEAR}}
url: {{URL}}
---
![[{{PDF}}]]`,
};

interface PaperMetadata {
    title: string;
    authors: string[];
    year: number;
    url: string;
}

const sanitizeTitle = (title: string): string =>
    title.toLowerCase().replace(/[-:,.]/g, ' ').replace(/\s+/g, ' ').trim();

const extractArxivId = (url: string): string | null => {
    const match = url.match(/arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/);
    return match ? match[2] : null;
};

export default class PapersPlugin extends Plugin {
    settings: Settings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: "import",
            name: "Import",
            callback: () => this.showImportModal(),
        });

        this.addCommand({
            id: "import-from-clipboard",
            name: "Import from clipboard",
            callback: () => this.createNoteFromClipboard(),
        });

        this.addSettingTab(new PapersSettingTab(this.app, this));
    }

    showImportModal() {
        new ImportSelectModal(this.app, async (choice) => {
            if (!choice) return;

            if (choice.isArxivUrl) {
                await this.processArxivUrl(choice.input);
            } else {
                await this.createNoteFromMetadata(choice);
            }
        }).open();
    }

    async processArxivUrl(input: string) {
        const arxivId = extractArxivId(input);
        if (!arxivId) {
            new Notice("Invalid arXiv URL.");
            return;
        }

        // Show loading notice for metadata fetch
        const metadataNotice = new Notice("Fetching paper metadata from arXiv...", 0);
        
        try {
            const metadata = await this.fetchArxivMetadata(arxivId);
            metadataNotice.hide();
            
            if (!metadata) {
                new Notice("Could not find metadata for the arXiv paper.");
                return;
            }

            await this.createNoteFromMetadata(metadata);
        } catch (error) {
            metadataNotice.hide();
            new Notice("Failed to fetch paper metadata.");
            console.error("Metadata fetch error:", error);
        }
    }

    async createNoteFromClipboard() {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText?.trim()) {
            new Notice("Clipboard is empty.");
            return;
        }

        if (extractArxivId(clipboardText)) {
            await this.processArxivUrl(clipboardText.trim());
            return;
        }

        const modal = new ImportSelectModal(this.app, async (choice) => {
            if (!choice) return;

            if (choice.isArxivUrl) {
                await this.processArxivUrl(choice.input);
            } else {
                await this.createNoteFromMetadata(choice);
            }
        });

        // Pre-fill and auto-search for clipboard content
        modal.currentInput = clipboardText.trim();
        modal.onOpen = function () {
            SuggestModal.prototype.onOpen.call(this);
            setTimeout(() => {
                if (this.inputEl) {
                    this.inputEl.value = clipboardText.trim();
                    this.inputEl.focus();
                    this.performSearch();
                }
            }, 10);
        };

        modal.open();
    }

    async createNoteFromMetadata(metadata: PaperMetadata) {
        const filename = this.sanitizeFileName(metadata.title) + ".md";
        const folderPath = this.settings.notesFolder?.trim()
            ? this.settings.notesFolder.trim().replace(/\/$/, "") + "/"
            : "";
        const filePath = folderPath + filename;

        const fileExists = await this.app.vault.adapter.exists(filePath);
        if (fileExists && !(await this.confirmOverwrite())) return;

        let pdfFilename = "";
        if (this.settings.noteTemplate.includes("{{PDF}}") && metadata.url.includes('arxiv.org')) {
            try {
                pdfFilename = await this.downloadPdf(metadata);
            } catch (error) {
                new Notice(`PDF download failed: ${error.message}`);
                console.error("PDF download error:", error);
            }
        }

        const content = this.formatNoteContent(metadata, pdfFilename);

        try {
            if (fileExists) {
                const file = await this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    await this.app.vault.modify(file, content);
                }
            } else {
                await this.app.vault.create(filePath, content);
            }

            new Notice("Created paper note: " + filename);

            const file = await this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf(true).openFile(file);
            }
        } catch (err) {
            new Notice("Error creating note: " + err);
        }
    }

    async downloadPdf(metadata: PaperMetadata): Promise<string> {
        const arxivId = extractArxivId(metadata.url);
        if (!arxivId) throw new Error("Could not extract arXiv ID from URL");

        const pdfFilename = this.sanitizeFileName(metadata.title) + ".pdf";
        const pdfFolderPath = this.settings.pdfFolder?.trim()
            ? this.settings.pdfFolder.trim().replace(/\/$/, "") + "/"
            : "";

        if (pdfFolderPath && !(await this.app.vault.adapter.exists(pdfFolderPath.slice(0, -1)))) {
            throw new Error(`PDF folder "${this.settings.pdfFolder}" doesn't exist. Please create it first.`);
        }

        const pdfPath = pdfFolderPath + pdfFilename;

        if (await this.app.vault.adapter.exists(pdfPath)) {
            return pdfFilename;
        }

        const progressNotice = new Notice("", 0);

        try {
            const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
            progressNotice.setMessage(`Downloading PDF for "${metadata.title}"...`);

            const response = await requestUrl(pdfUrl)

            if (!response.arrayBuffer) {
                throw new Error("Failed to download PDF content");
            }

            const uint8Array = new Uint8Array(response.arrayBuffer);
            await this.app.vault.adapter.writeBinary(pdfPath, uint8Array);

            progressNotice.hide();
            return pdfFilename;
        } catch (error) {
            progressNotice.setMessage(`Failed to download PDF for "${metadata.title}"`);
            setTimeout(() => progressNotice.hide(), 5000);
            throw new Error(`Failed to download PDF: ${error.message}`);
        }
    }

    async fetchArxivMetadata(arxivId: string): Promise<PaperMetadata | null> {
        try {
            const response = await requestUrl(`https://export.arxiv.org/api/query?id_list=${arxivId}`);
            
            const text = response.text;
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, "application/xml");
            const entry = xml.querySelector("entry");
            if (!entry) return null;

            const title = entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") || "";
            const authors = Array.from(entry.querySelectorAll("author > name")).map(e => e.textContent || "");
            const published = entry.querySelector("published")?.textContent || "";
            const year = new Date(published).getFullYear();

            return { title, authors, year, url: `https://arxiv.org/abs/${arxivId}` };
        } catch (error) {
            console.error("Failed to fetch arXiv metadata:", error);
            return null;
        }
    }

    sanitizeFileName(title: string): string {
        return title
            .replace(/:/g, " - ")
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s{2,}/g, " ") // Collapse 2+ spaces into 1
            .trim();
    }

    formatNoteContent(metadata: PaperMetadata, pdfFilename = ""): string {
        let content = this.settings.noteTemplate;
        const authorsYaml = metadata.authors.map(author => `  - ${author}`).join('\n');

        return content
            .replace(/\{\{TITLE\}\}/g, this.sanitizeFileName(metadata.title))
            .replace(/\{\{URL\}\}/g, metadata.url)
            .replace(/\{\{YEAR\}\}/g, metadata.year.toString())
            .replace(/\{\{AUTHORS\}\}/g, authorsYaml)
            .replace(/\{\{PDF\}\}/g, pdfFilename);
    }

    confirmOverwrite(): Promise<boolean> {
        return new Promise(resolve => {
            new ConfirmOverwriteModal(this.app, resolve).open();
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class ImportSelectModal extends SuggestModal<PaperMetadata> {
    choices: PaperMetadata[] = [];
    onChoice: (choice: any | null) => void;
    loading = false;
    hasSearched = false;
    currentInput = "";

    constructor(app: App, onChoice: (choice: any | null) => void) {
        super(app);
        this.onChoice = onChoice;
        this.setPlaceholder("Search paper title or arXiv URL...");
    }

    onOpen() {
        super.onOpen();

        // if (this.resultContainerEl) {
        //     this.resultContainerEl.style.display = 'none';
        // }
        if (this.resultContainerEl) this.resultContainerEl.hide();

        setTimeout(() => {
            if (this.inputEl) {
                this.inputEl.focus();
                this.inputEl.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter' && !this.hasSearched && !this.loading) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        this.performSearch();
                    }
                });
            }
        }, 10);
    }

    getSuggestions(query: string): PaperMetadata[] {
        this.currentInput = query;

        if (this.loading || !this.hasSearched || !this.choices.length) {
            return [];
        }

        const sanitized = sanitizeTitle(query);
        return this.choices
            .filter(choice => {
                const sim = compareTwoStrings(sanitizeTitle(choice.title), sanitized);
                return sim > 0.3;
            })
            .sort((a, b) => {
                const simA = compareTwoStrings(sanitizeTitle(a.title), sanitized);
                const simB = compareTwoStrings(sanitizeTitle(b.title), sanitized);
                return simB - simA;
            });
    }

    renderSuggestion(choice: PaperMetadata, el: HTMLElement) {
        el.createEl("div", { text: choice.title });
        if (choice.authors?.length) {
            el.createEl("small", { text: choice.authors.join(", ") });
        }
    }

    onChooseSuggestion(item: PaperMetadata) {
        this.onChoice(item);
    }

    manualRefresh() {
        setTimeout(() => {
            if (this.inputEl) {
                this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 0);
    }

    async performSearch() {
        const input = this.inputEl?.value?.trim() || this.currentInput.trim();
        if (!input) return;

        if (extractArxivId(input)) {
            this.close();
            this.onChoice({ isArxivUrl: true, input });
            return;
        }

        this.setLoading(true);

        try {
            const results = await this.searchArxivByTitle(input);
            this.setSearchResults(results);
        } catch (error) {
            console.error("Search failed:", error);
            this.setSearchResults([]);
            this.emptyStateText = "Search failed. Please try again.";
            this.loading = false;
            this.hasSearched = true;
            if (this.inputEl) this.inputEl.disabled = false;
            this.manualRefresh();
        }
    }

    setLoading(isLoading: boolean) {
        this.loading = isLoading;

        if (this.inputEl) this.inputEl.disabled = isLoading;

        if (isLoading) {
            this.emptyStateText = "Searching arXiv...";
            this.hasSearched = true;
            // if (this.resultContainerEl) this.resultContainerEl.style.display = '';
            if (this.resultContainerEl) this.resultContainerEl.show();
        }

        this.manualRefresh();
    }

    setSearchResults(results: PaperMetadata[]) {
        this.loading = false;
        this.hasSearched = true;
        this.choices = results;

        // if (this.resultContainerEl) this.resultContainerEl.style.display = '';
        if (this.resultContainerEl) this.resultContainerEl.show();

        this.emptyStateText = results.length === 0 ? "No results found" : "No matching results";

        if (this.inputEl) this.inputEl.disabled = false;
        this.manualRefresh();
    }

    async searchArxivByTitle(title: string, maxRetries = 3): Promise<PaperMetadata[]> {
        const sanitized = sanitizeTitle(title);
        // Fix: Handle spaces properly for arXiv API
        const query = sanitized.split(' ').map(word => encodeURIComponent(word)).join('+');
        const url = `https://export.arxiv.org/api/query?search_query=ti:"${query}"&start=0&max_results=10`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await requestUrl(url);
                
                const text = response.text;
                const parser = new DOMParser();
                const xml = parser.parseFromString(text, "application/xml");
                const entries = Array.from(xml.querySelectorAll("entry"));

                return entries.map(entry => {
                    const title = entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") || "";
                    const authors = Array.from(entry.querySelectorAll("author > name")).map(e => e.textContent || "");
                    const published = entry.querySelector("published")?.textContent || "";
                    const year = new Date(published).getFullYear();
                    const id = entry.querySelector("id")?.textContent?.match(/\d{4}\.\d{4,5}/)?.[0] || "";

                    return { title, authors, year, url: `https://arxiv.org/abs/${id}` };
                });

            } catch (error) {
                console.warn(`ArXiv search attempt ${attempt}/${maxRetries} failed:`, error);

                const errorMessage = (error as Error).message;
                const isNetworkError = errorMessage.includes('ERR_CONNECTION_RESET') ||
                    errorMessage.includes('ERR_NETWORK') ||
                    errorMessage.includes('request');

                if (!isNetworkError || attempt === maxRetries) {
                    throw error;
                }

                const delay = Math.pow(2, attempt - 1) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));

                this.emptyStateText = `Searching arXiv... (retry ${attempt + 1}/${maxRetries})`;
                this.manualRefresh();
            }
        }
        return [];
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

        titleEl.setText("File exists");
        contentEl.empty();
        contentEl.createEl("p", { text: "A note with this title already exists. Do you want to overwrite?" });

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        Object.assign(buttonContainer.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            marginTop: "30px"
        });

        const overwriteButton = buttonContainer.createEl("button", { text: "Overwrite", cls: "mod-warning" });
        overwriteButton.onclick = () => {
            this.close();
            this.onDecision(true);
        };

        const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
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
            .setDesc("Folder to save paper notes.")
            .addText(text =>
                text
                    .setPlaceholder("Example: Research/Papers")
                    .setValue(this.plugin.settings.notesFolder)
                    .onChange(async value => {
                        this.plugin.settings.notesFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("PDF folder")
            .setDesc("Folder to save PDFs. These are only downloaded if notes contain the {{PDF}} placeholder.")
            .addText(text =>
                text
                    .setPlaceholder("Example: Research/PDF")
                    .setValue(this.plugin.settings.pdfFolder)
                    .onChange(async value => {
                        this.plugin.settings.pdfFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        const templateSetting = new Setting(containerEl)
            .setName("Note template")
            .setDesc("Template for creating paper notes. Use {{TITLE}}, {{AUTHORS}}, {{YEAR}}, {{URL}}, and {{PDF}} to insert metadata.")
            .addTextArea(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.noteTemplate)
                    .setValue(this.plugin.settings.noteTemplate || DEFAULT_SETTINGS.noteTemplate)
                    .onChange(async value => {
                        this.plugin.settings.noteTemplate = value || DEFAULT_SETTINGS.noteTemplate;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 10;
                Object.assign(text.inputEl.style, {
                    width: "100%",
                    minWidth: "100%"
                });
            });

        Object.assign(templateSetting.settingEl.style, {
            display: "block"
        });

        const controlEl = templateSetting.settingEl.querySelector('.setting-item-control') as HTMLElement;
        if (controlEl) {
            Object.assign(controlEl.style, {
                marginTop: "10px"
            });
        }
    }
}