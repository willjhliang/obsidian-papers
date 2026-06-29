import {
    AbstractInputSuggest,
    App,
    Editor,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    SuggestModal,
    TFile,
    TFolder,
    requestUrl,
} from "obsidian";

import compareTwoStrings from 'string-similarity-js';

interface Settings {
    notesFolder: string;
    pdfFolder: string;
    templateFile: string;
    useQueryAsAlias: boolean;
}

const DEFAULT_TEMPLATE = `---
title: "{{title}}"
authors: {{authors}}
year: {{year}}
url: {{url}}
---
![[{{pdf}}]]`;

const DEFAULT_SETTINGS: Settings = {
    notesFolder: "",
    pdfFolder: "",
    useQueryAsAlias: false,
    templateFile: "",
};

interface PaperMetadata {
    title: string;
    authors: string[];
    year: number;
    url: string;
}

type ImportChoice = PaperMetadata | { isArxivUrl: true; input: string };

interface PaperEntry {
    file: TFile;
    title: string;
    authors: string[];
    searchText: string;
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

        this.addCommand({
            id: "cite",
            name: "Cite",
            editorCallback: (editor) => this.showCiteModal(editor),
        });

        this.addSettingTab(new PapersSettingTab(this.app, this));
    }

    showImportModal() {
        new ImportSelectModal(this.app, (choice) => {
            if (!choice) return;

            const task = ('isArxivUrl' in choice)
                ? this.processArxivUrl(choice.input)
                : this.createNoteFromMetadata(choice);
            void task;
        }).open();
    }

    async showCiteModal(editor: Editor) {
        const papers = await this.getAllSavedPapers();
        if (!papers.length) {
            new Notice("No saved papers found.");
            return;
        }

        new CiteSelectModal(this.app, papers, this.settings.useQueryAsAlias, (entry, name) => {
            const target = entry.file.basename;
            const display = name || entry.title;
            const link = (display === target) ? `[[${target}]]` : `[[${target}|${display}]]`;
            editor.replaceSelection(link);
        }).open();
    }

    async getAllSavedPapers(): Promise<PaperEntry[]> {
        const notesFolder = this.settings.notesFolder.trim();
        let files: TFile[];

        const folder = notesFolder
            ? this.app.vault.getAbstractFileByPath(notesFolder)
            : null;

        if (folder instanceof TFolder) {
            files = folder.children.filter(
                (f): f is TFile => f instanceof TFile && f.extension === "md"
            );
        } else {
            const prefix = notesFolder ? notesFolder + "/" : "";
            files = this.app.vault
                .getMarkdownFiles()
                .filter(f => !prefix || f.path.startsWith(prefix));
        }

        const entries = await Promise.all(files.map(async (file) => {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const title = frontmatter?.title ?? file.basename;
            const rawAuthors = frontmatter?.authors;
            const authors: string[] = Array.isArray(rawAuthors)
                ? rawAuthors
                : rawAuthors ? [rawAuthors] : [];
            const content = await this.app.vault.cachedRead(file);
            const searchText = `${title}\n${authors.join(" ")}\n${content}`.toLowerCase();

            return { file, title, authors, searchText } as PaperEntry;
        }));

        return entries;
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

        const modal = new ImportSelectModal(this.app, (choice) => {
            if (!choice) return;

            const task = ('isArxivUrl' in choice)
                ? this.processArxivUrl(choice.input)
                : this.createNoteFromMetadata(choice);
            void task;
        });

        // Pre-fill and auto-search for clipboard content
        modal.currentInput = clipboardText.trim();
        modal.onOpen = function () {
            SuggestModal.prototype.onOpen.call(this);
            activeWindow.setTimeout(() => {
                if (this.inputEl) {
                    this.inputEl.value = clipboardText.trim();
                    this.inputEl.focus();
                    void this.performSearch();
                }
            }, 10);
        };

        modal.open();
    }

    async getTemplate(): Promise<string> {
        const path = this.settings.templateFile.trim();
        if (path) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                return await this.app.vault.cachedRead(file);
            }
            new Notice(`Template file "${path}" not found. Using default template.`);
        }
        return DEFAULT_TEMPLATE;
    }

    async createNoteFromMetadata(metadata: PaperMetadata) {
        const filename = this.sanitizeFileName(metadata.title) + ".md";
        const folderPath = this.settings.notesFolder?.trim()
            ? this.settings.notesFolder.trim().replace(/\/$/, "") + "/"
            : "";
        const filePath = folderPath + filename;

        const fileExists = await this.app.vault.adapter.exists(filePath);
        if (fileExists && !(await this.confirmOverwrite())) return;

        const template = await this.getTemplate();

        let pdfFilename = "";
        if (template.includes("{{pdf}}") && metadata.url.includes('arxiv.org')) {
            try {
                pdfFilename = await this.downloadPdf(metadata);
            } catch (error) {
                new Notice(`PDF download failed: ${error.message}`);
                console.error("PDF download error:", error);
            }
        }

        const content = this.formatNoteContent(template, metadata, pdfFilename);

        try {
            if (fileExists) {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    await this.app.vault.modify(file, content);
                }
            } else {
                await this.app.vault.create(filePath, content);
            }

            new Notice("Created paper note: " + filename);

            const file = this.app.vault.getAbstractFileByPath(filePath);
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
            throw new Error(`PDF location "${this.settings.pdfFolder}" doesn't exist. Please create it first.`);
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
            activeWindow.setTimeout(() => progressNotice.hide(), 5000);
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

    formatNoteContent(template: string, metadata: PaperMetadata, pdfFilename = ""): string {
        return template
            .replace(/\{\{title\}\}/g, this.sanitizeFileName(metadata.title))
            .replace(/\{\{url\}\}/g, metadata.url)
            .replace(/\{\{year\}\}/g, metadata.year.toString())
            .replace(/^([^\n]*)\{\{authors\}\}/gm, (_match, prefix) =>
                this.renderAuthors(prefix, metadata.authors))
            .replace(/\{\{pdf\}\}/g, pdfFilename);
    }

    // Expand {{authors}} into a YAML block list. When the placeholder follows a
    // key inline (e.g. "authors: {{authors}}"), the list starts on the next line
    // indented two spaces; when it sits alone on its line, items inherit that
    // line's leading indentation.
    renderAuthors(prefix: string, authors: string[]): string {
        if (prefix.trim() === "") {
            if (!authors.length) return prefix + "[]";
            return prefix + authors.map(a => `- ${a}`).join(`\n${prefix}`);
        }

        const key = prefix.replace(/[ \t]+$/, "");
        if (!authors.length) return `${key} []`;
        return key + authors.map(a => `\n  - ${a}`).join("");
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
    onChoice: (choice: ImportChoice | null) => void;
    loading = false;
    hasSearched = false;
    currentInput = "";

    constructor(app: App, onChoice: (choice: ImportChoice | null) => void) {
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

        activeWindow.setTimeout(() => {
            if (this.inputEl) {
                this.inputEl.focus();
                this.inputEl.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter' && !this.hasSearched && !this.loading) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        void this.performSearch();
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
        el.createDiv({ text: choice.title });
        if (choice.authors?.length) {
            el.createEl("small", { text: choice.authors.join(", ") });
        }
    }

    onChooseSuggestion(item: PaperMetadata) {
        this.onChoice(item);
    }

    manualRefresh() {
        activeWindow.setTimeout(() => {
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
                await new Promise(resolve => activeWindow.setTimeout(resolve, delay));

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

class CiteSelectModal extends SuggestModal<PaperEntry> {
    papers: PaperEntry[];
    useQueryAsAlias: boolean;
    onPick: (entry: PaperEntry, name: string) => void;
    selectedPaper: PaperEntry | null = null;
    nameInputEl: HTMLInputElement | null = null;

    constructor(app: App, papers: PaperEntry[], useQueryAsAlias: boolean, onPick: (entry: PaperEntry, name: string) => void) {
        super(app);
        this.papers = papers;
        this.useQueryAsAlias = useQueryAsAlias;
        this.onPick = onPick;
        this.setPlaceholder("Search saved papers...");
    }

    onOpen() {
        super.onOpen();

        activeWindow.setTimeout(() => {
            this.inputEl?.focus();
        }, 10);
    }

    getSuggestions(query: string): PaperEntry[] {
        if (this.selectedPaper) return [];

        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = tokens.length
            ? this.papers.filter(p => tokens.every(t => p.searchText.includes(t)))
            : this.papers.slice();

        const sanitized = sanitizeTitle(query);
        return matches.sort((a, b) =>
            compareTwoStrings(sanitizeTitle(b.title), sanitized) -
            compareTwoStrings(sanitizeTitle(a.title), sanitized)
        );
    }

    renderSuggestion(entry: PaperEntry, el: HTMLElement) {
        el.createDiv({ text: entry.title });
        if (entry.authors?.length) {
            el.createEl("small", { text: entry.authors.join(", ") });
        }
    }

    selectSuggestion(value: PaperEntry, evt: MouseEvent | KeyboardEvent) {
        this.selectedPaper = value;

        // Replace the search box with the chosen paper, rendered inside the
        // results list so its spacing matches a real list entry exactly.
        const inputContainer = this.inputEl?.parentElement;
        inputContainer?.hide();

        const container = this.resultContainerEl;
        container.empty();
        const selectedEl = container.createDiv({ cls: "suggestion-item papers-cite-selected" });
        this.renderSuggestion(value, selectedEl);
        container.show();

        this.showNameRow(container, evt instanceof KeyboardEvent);
    }

    showNameRow(anchor: HTMLElement, viaKeyboard: boolean) {
        if (this.nameInputEl) return;

        const row = createDiv({ cls: "prompt-input-container papers-cite-name-row" });
        const nameInput = row.createEl("input", {
            cls: "prompt-input",
            attr: { type: "text", placeholder: "Enter alias (or leave blank)..." },
        });
        anchor.insertAdjacentElement("afterend", row);
        this.nameInputEl = nameInput;

        // Optionally seed the alias with the search query (still held in inputEl).
        if (this.useQueryAsAlias) {
            nameInput.value = this.inputEl?.value.trim() ?? "";
        }

        // Submit on keyup — Obsidian's modal keymap consumes Enter on keydown.
        nameInput.addEventListener("keyup", (e) => {
            if (e.key === "Enter" && this.selectedPaper) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.onPick(this.selectedPaper, nameInput.value.trim());
                this.close();
            }
        });

        // Backspace on the empty alias input returns to the paper search.
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Backspace" && nameInput.value === "") {
                e.preventDefault();
                this.resetToSearch();
            }
        });

        // Move focus to the name input only AFTER the selecting Enter is released,
        // so its keyup can't land here and submit instantly. (Mouse picks: focus now.)
        if (viaKeyboard) {
            const onRelease = (e: KeyboardEvent) => {
                if (e.key !== "Enter") return;
                activeWindow.removeEventListener("keyup", onRelease, true);
                nameInput.focus();
            };
            activeWindow.addEventListener("keyup", onRelease, true);
        } else {
            activeWindow.setTimeout(() => nameInput.focus(), 10);
        }
    }

    resetToSearch() {
        this.selectedPaper = null;

        // Remove the alias row and reveal the search box again.
        this.nameInputEl?.parentElement?.remove();
        this.nameInputEl = null;
        this.inputEl?.parentElement?.show();
        this.inputEl?.focus();

        // Re-run the search so the results list replaces the chosen-paper entry.
        this.inputEl?.dispatchEvent(new Event("input", { bubbles: true }));
    }

    onChooseSuggestion() {
        // Handled by selectSuggestion override (two-phase flow).
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

class FolderSuggest extends AbstractInputSuggest<TFolder> {
    constructor(
        app: App,
        private inputEl: HTMLInputElement,
        private onSelectFolder: (value: string) => void
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): TFolder[] {
        const lowerQuery = query.toLowerCase();
        return this.app.vault
            .getAllLoadedFiles()
            .filter(
                (file): file is TFolder =>
                    file instanceof TFolder &&
                    file.path.toLowerCase().contains(lowerQuery)
            );
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder): void {
        this.inputEl.value = folder.path;
        this.inputEl.trigger("input");
        this.onSelectFolder(folder.path);
        this.close();
    }
}

class FileSuggest extends AbstractInputSuggest<TFile> {
    constructor(
        app: App,
        private inputEl: HTMLInputElement,
        private onSelectFile: (value: string) => void
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): TFile[] {
        const lowerQuery = query.toLowerCase();
        return this.app.vault
            .getMarkdownFiles()
            .filter(file => file.path.toLowerCase().contains(lowerQuery));
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.setText(file.path);
    }

    selectSuggestion(file: TFile): void {
        this.inputEl.value = file.path;
        this.inputEl.trigger("input");
        this.onSelectFile(file.path);
        this.close();
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

        new Setting(containerEl).setName("Import").setHeading();

        new Setting(containerEl)
            .setName("Notes location")
            .setDesc("Folder to save paper notes.")
            .addText(text => {
                new FolderSuggest(this.app, text.inputEl, value => {
                    this.plugin.settings.notesFolder = value;
                    void this.plugin.saveSettings();
                });
                text
                    .setPlaceholder("Example: Research/Papers")
                    .setValue(this.plugin.settings.notesFolder)
                    .onChange(async value => {
                        this.plugin.settings.notesFolder = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("PDF location")
            .setDesc("Folder to save PDFs. These are only downloaded if notes contain the {{pdf}} placeholder.")
            .addText(text => {
                new FolderSuggest(this.app, text.inputEl, value => {
                    this.plugin.settings.pdfFolder = value;
                    void this.plugin.saveSettings();
                });
                text
                    .setPlaceholder("Example: Research/PDF")
                    .setValue(this.plugin.settings.pdfFolder)
                    .onChange(async value => {
                        this.plugin.settings.pdfFolder = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Note template")
            .setDesc(createFragment(frag => {
                frag.appendText("Template for imported paper notes.");
                frag.createEl("br");
                frag.appendText("Use {{title}}, {{authors}}, {{year}}, {{url}}, {{pdf}} to insert metadata.");
            }))
            .addText(text => {
                new FileSuggest(this.app, text.inputEl, value => {
                    this.plugin.settings.templateFile = value;
                    void this.plugin.saveSettings();
                });
                text
                    .setPlaceholder("Example: Research/Paper Template.md")
                    .setValue(this.plugin.settings.templateFile)
                    .onChange(async value => {
                        this.plugin.settings.templateFile = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl).setName("Cite").setHeading();

        new Setting(containerEl)
            .setName("Use query as alias")
            .setDesc("When citing, prefill the alias input with your search query.")
            .addToggle(toggle => {
                toggle
                    .setValue(this.plugin.settings.useQueryAsAlias)
                    .onChange(async value => {
                        this.plugin.settings.useQueryAsAlias = value;
                        await this.plugin.saveSettings();
                    });
            });
    }
}