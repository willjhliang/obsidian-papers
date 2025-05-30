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
            id: "import",
            name: "Import",
            callback: () => this.showImportModal(),
        });

        this.addCommand({
            id: "import-from-clipboard",
            name: "Import from Clipboard",
            callback: () => this.createNoteFromClipboard(),
        });

        this.addSettingTab(new PapersSettingTab(this.app, this));
    }

    // Replace both showImportModal() and the processInput logic with this:

    showImportModal() {
        const modal = new ImportSelectModal(this.app, async (choice) => {
            if (!choice) {
                new Notice("Cancelled.");
                return;
            }

            // Handle arXiv URL directly
            if (choice.isArxivUrl) {
                await this.processArxivUrl(choice.input);
                return;
            }

            // Handle selected paper from search results
            await this.createNoteFromMetadata(choice);
        });
        modal.open();
    }

    async processArxivUrl(input: string) {
        const arxivIdMatch = input.match(/arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/);
        const arxivId = arxivIdMatch ? arxivIdMatch[2] : null;

        if (arxivId) {
            const metadata = await this.fetchArxivMetadata(arxivId);
            if (!metadata) {
                new Notice("Could not find metadata for the arXiv paper.");
                return;
            }
            await this.createNoteFromMetadata(metadata);
        } else {
            new Notice("Invalid arXiv URL.");
        }
    }

    async createNoteFromClipboard() {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText?.trim()) {
            new Notice("Clipboard is empty.");
            return;
        }

        // Check if clipboard contains an arXiv URL
        const arxivIdMatch = clipboardText.match(/arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/);
        if (arxivIdMatch) {
            await this.processArxivUrl(clipboardText.trim());
        } else {
            // Open the modal with clipboard text pre-filled
            const modal = new ImportSelectModal(this.app, async (choice) => {
                if (!choice) {
                    new Notice("Cancelled.");
                    return;
                }

                if (choice.isArxivUrl) {
                    await this.processArxivUrl(choice.input);
                    return;
                }

                await this.createNoteFromMetadata(choice);
            });

            // Pre-fill the input with clipboard text
            modal.onOpen = function () {
                SuggestModal.prototype.onOpen.call(this);
                setTimeout(() => {
                    if (this.inputEl) {
                        this.inputEl.value = clipboardText.trim();
                        this.inputEl.focus();
                        this.onInputChanged();
                    }
                }, 10);
            };

            modal.open();
        }
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

        // Check if PDF download is needed ({{PDF}} placeholder exists)
        let pdfFilename = "";
        const needsPdf = this.settings.noteTemplate.includes("{{PDF}}");
        
        if (needsPdf && metadata.url.includes('arxiv.org')) {
            try {
                pdfFilename = await this.downloadPdfFromMetadata(metadata);
            } catch (error) {
                new Notice(`PDF download failed: ${error.message}`);
                console.error("PDF download error:", error);
                // Continue with note creation without PDF
            }
        }

        const content = this.formatNoteContent(metadata, pdfFilename);

        try {
            if (fileExists) {
                const file = await this.app.vault.getAbstractFileByPath(filePath);
                await this.app.vault.modify(file, content);
            } else {
                await this.app.vault.create(filePath, content);
            }
            new Notice("Created paper note: " + filename);

            // Open the newly created note
            const file = await this.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                await this.app.workspace.getLeaf(true).openFile(file);
            }
        } catch (err) {
            new Notice("Error creating note: " + err);
        }
    }
// Replace your downloadPdfFromMetadata method with this enhanced version:

async downloadPdfFromMetadata(metadata: { title: string; url: string }): Promise<string> {
    // Extract arXiv ID from URL
    const idMatch = metadata.url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(v\d+)?/);
    if (!idMatch) {
        throw new Error("Could not extract arXiv ID from URL");
    }

    const arxivId = idMatch[1];
    const pdfFilename = this.sanitizeFileName(metadata.title) + ".pdf";

    // Setup PDF folder path
    const pdfFolderPath = this.settings.pdfFolder?.trim()
        ? this.settings.pdfFolder.trim().replace(/\/$/, "") + "/"
        : "";

    // Check if PDF folder exists
    if (pdfFolderPath && !(await this.app.vault.adapter.exists(pdfFolderPath.slice(0, -1)))) {
        throw new Error(`PDF folder "${this.settings.pdfFolder}" doesn't exist. Please create it first.`);
    }

    const pdfPath = pdfFolderPath + pdfFilename;

    // Check if PDF already exists
    if (await this.app.vault.adapter.exists(pdfPath)) {
        new Notice(`PDF already exists: ${pdfFilename}`);
        return pdfFilename;
    }

    // Create a persistent notice for download progress
    const progressNotice = new Notice("", 0); // 0 = infinite duration
    
    try {
        await this.downloadPdfWithProgress(metadata.url, pdfPath, metadata.title, progressNotice);
        setTimeout(() => progressNotice.hide(), 0);
        
        return pdfFilename;
    } catch (error) {
        // Error message
        progressNotice.setMessage(`Failed to download PDF for "${metadata.title}"`);
        
        // Auto-hide error message after 5 seconds
        setTimeout(() => progressNotice.hide(), 5000);
        
        throw new Error(`Failed to download PDF: ${error.message}`);
    }
}

// Replace your downloadPdf method with this enhanced version:

async downloadPdfWithProgress(
    arxivUrl: string, 
    savePath: string, 
    title: string,
    progressNotice: Notice
) {
    // Extract arXiv ID from URL (handle both abs and direct URLs)
    const idMatch = arxivUrl.match(/arxiv\.org\/(abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/);
    if (!idMatch) throw new Error("Invalid arXiv URL");

    const arxivId = idMatch[2];
    const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;

    // Show initial progress
    progressNotice.setMessage(`Downloading PDF for "${title}"...`);

    try {
        // Use Obsidian's requestUrl to bypass CORS
        const response = await requestUrl({
            url: pdfUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ObsidianPapersPlugin/1.0)'
            }
        });

        if (!response.arrayBuffer) {
            throw new Error("Failed to download PDF content");
        }

        const uint8Array = new Uint8Array(response.arrayBuffer);
        await this.app.vault.adapter.writeBinary(savePath, uint8Array);
        
    } catch (error) {
        throw new Error(`Network error downloading PDF: ${error.message}`);
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
    }, pdfFilename: string = ""): string {
        let content = this.settings.noteTemplate;
        
        // Replace placeholders
        content = content.replace(/\{\{TITLE\}\}/g, metadata.title.replace(/:/g, " - "));
        content = content.replace(/\{\{URL\}\}/g, metadata.url);
        content = content.replace(/\{\{YEAR\}\}/g, metadata.year.toString());
        
        // Handle authors - format as YAML array
        const authorsYaml = metadata.authors.map(author => `  - ${author}`).join('\n');
        content = content.replace(/\{\{AUTHORS\}\}/g, authorsYaml);
        
        // Handle PDF placeholder
        if (pdfFilename) {
            content = content.replace(/\{\{PDF\}\}/g, pdfFilename);
        } else {
            // Remove PDF placeholder if no PDF was downloaded
            content = content.replace(/\{\{PDF\}\}/g, '');
        }
        
        return content;
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

class ImportSelectModal extends SuggestModal<any> {
    choices: any[] = [];
    onChoice: (choice: any | null) => void;
    loading: boolean = false;
    hasSearched: boolean = false;
    currentInput: string = "";

    constructor(app: App, onChoice: (choice: any | null) => void) {
        super(app);
        this.onChoice = onChoice;
        this.emptyStateText = "Press Enter to search";
        this.setPlaceholder("Enter paper title or arXiv URL...");
    }

    onOpen() {
        super.onOpen();

        // Hide results container initially
        if (this.resultContainerEl) {
            this.resultContainerEl.style.display = 'none';
        }

        setTimeout(() => {
            if (this.inputEl) {
                this.inputEl.focus();

                // Intercept Enter key at modal level to handle search
                this.modalEl?.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !this.hasSearched && !this.loading) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        this.performSearch();
                    }
                }, true);

                // Fallback handler for keyup
                this.inputEl.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter' && !this.hasSearched && !this.loading) {
                        this.performSearch();
                    }
                });
            }
        }, 10);
    }

    getSuggestions(query: string): any[] {
        this.currentInput = query;

        if (this.loading || !this.hasSearched) {
            return [];
        }

        if (this.choices.length > 0) {
            const sanitized = sanitizeTitle(query);

            return this.choices
                .filter(choice => {
                    const sim = stringSimilarity.compareTwoStrings(
                        sanitizeTitle(choice.title),
                        sanitized
                    );
                    return sim > 0.3;
                })
                .sort((a, b) => {
                    const simA = stringSimilarity.compareTwoStrings(
                        sanitizeTitle(a.title),
                        sanitized
                    );
                    const simB = stringSimilarity.compareTwoStrings(
                        sanitizeTitle(b.title),
                        sanitized
                    );
                    return simB - simA;
                });
        }

        return [];
    }

    renderSuggestion(choice: any, el: HTMLElement) {
        el.createEl("div", { text: choice.title });
        if (choice.authors && choice.authors.length) {
            el.createEl("small", { text: choice.authors.join(", ") });
        }
    }

    onChooseSuggestion(item: any, evt: MouseEvent | KeyboardEvent) {
        this.onChoice(item);
    }

    onInputChanged(): void {
        super.onInputChanged();

        if (!this.hasSearched && !this.loading) {
            if (this.currentInput.trim()) {
                this.emptyStateText = "Press Enter to search or import";
            } else {
                this.emptyStateText = "Enter paper title or arXiv URL...";
            }
        }
    }

    async performSearch() {
        const input = this.inputEl?.value?.trim() || this.currentInput.trim();

        if (!input) return;

        // Check if input is an arXiv URL
        const arxivIdMatch = input.match(/arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/);
        if (arxivIdMatch) {
            this.close();
            this.onChoice({ isArxivUrl: true, input: input });
            return;
        }

        // Search arXiv
        this.setLoading(true, input);

        try {
            const results = await this.searchArxivByTitle(input);
            this.setSearchResults(results || []);
        } catch (error) {
            console.error("Search failed:", error);
            this.setSearchResults([]);
            // Show user-friendly error message
            this.emptyStateText = "Search failed. Please try again.";
            this.loading = false;
            this.hasSearched = true;
            if (this.inputEl) {
                this.inputEl.disabled = false;
            }
            this.onInput();
        }
    }

    setLoading(isLoading: boolean, queryText?: string) {
        this.loading = isLoading;

        if (this.inputEl) {
            this.inputEl.disabled = isLoading;
        }

        if (isLoading && queryText) {
            this.emptyStateText = "Searching arXiv...";
            this.hasSearched = true;

            // Show results container when starting to search
            if (this.resultContainerEl) {
                this.resultContainerEl.style.display = '';
            }
        }

        this.onInput();
    }

    setSearchResults(results: any[]) {
        this.loading = false;
        this.hasSearched = true;
        this.choices = results;

        // Ensure results container is visible
        if (this.resultContainerEl) {
            this.resultContainerEl.style.display = '';
        }

        if (results.length === 0) {
            this.emptyStateText = "No results found";
        } else {
            this.emptyStateText = "No matching results";
        }

        if (this.inputEl) {
            this.inputEl.disabled = false;
        }

        this.onInput();
    }

    async searchArxivByTitle(title: string, maxRetries: number = 3) {
        const sanitized = sanitizeTitle(title);
        const query = encodeURIComponent(sanitized);
        const url = `https://export.arxiv.org/api/query?search_query=ti:${query}&start=0&max_results=10`;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url);
                const text = await response.text();

                const parser = new DOMParser();
                const xml = parser.parseFromString(text, "application/xml");
                const entries = Array.from(xml.querySelectorAll("entry"));

                if (entries.length === 0) return [];

                return entries.map((entry) => {
                    const t = entry
                        .querySelector("title")
                        ?.textContent?.trim()
                        .replace(/\s+/g, " ") || "";
                    const authors = Array.from(entry.querySelectorAll("author > name")).map(
                        (e) => e.textContent || ""
                    );
                    const published = entry.querySelector("published")?.textContent || "";
                    const year = new Date(published).getFullYear();
                    const id = entry.querySelector("id")?.textContent?.match(/\d{4}\.\d{4,5}/)?.[0] || "";

                    return { title: t, authors, year, url: `https://arxiv.org/abs/${id}` };
                });

            } catch (error) {
                console.warn(`ArXiv search attempt ${attempt}/${maxRetries} failed:`, error);

                // Only retry on network errors, not parsing errors
                const errorMessage = (error as Error).message;
                const isNetworkError = errorMessage.includes('ERR_CONNECTION_RESET') ||
                    errorMessage.includes('ERR_NETWORK') ||
                    errorMessage.includes('fetch');

                if (!isNetworkError || attempt === maxRetries) {
                    throw error;
                }

                // Wait before retrying (exponential backoff: 1s, 2s, 4s...)
                const delay = Math.pow(2, attempt - 1) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));

                // Update status text to show retry
                this.emptyStateText = `Searching arXiv... (retry ${attempt + 1}/${maxRetries})`;
                this.onInput();
            }
        }
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
            .setDesc("Folder to save paper notes.")
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
            .setName("PDF folder")
            .setDesc("Folder to save PDFs. These are only downloaded if notes contain the {{PDF}} placeholder.")
            .addText((text) =>
                text
                    .setPlaceholder("Example: Research/PDF")
                    .setValue(this.plugin.settings.pdfFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.pdfFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        const templateSetting = new Setting(containerEl)
            .setName("Note template")
            .setDesc("Template for creating paper notes. Use {{TITLE}}, {{AUTHORS}}, {{YEAR}}, {{URL}}, and {{PDF}} to insert metadata.")
            .addTextArea((text) => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.noteTemplate)
                    .setValue(this.plugin.settings.noteTemplate || DEFAULT_SETTINGS.noteTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.noteTemplate = value || DEFAULT_SETTINGS.noteTemplate;
                        await this.plugin.saveSettings();
                    });
                
                // Make the textarea larger and full width
                text.inputEl.rows = 10;
                text.inputEl.style.width = "100%";
                text.inputEl.style.minWidth = "100%";
            });
        
        // Make the setting control take full width
        templateSetting.settingEl.style.display = "block";
        const controlEl = templateSetting.settingEl.querySelector('.setting-item-control');
        if (controlEl) {
            (controlEl as HTMLElement).style.width = "100%";
            (controlEl as HTMLElement).style.maxWidth = "none";
            (controlEl as HTMLElement).style.marginTop = "10px";
        }
    }
}