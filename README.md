# Papers for Obsidian

Papers is a simple plugin that retrieves, imports, and cites research papers. It queries the arXiv API to download PDFs and save metadata directly into the vault.

<img width="1147" height="720" alt="papers" src="https://github.com/user-attachments/assets/61b65751-da78-44af-b80b-b8e4aec8c0ee" />

## Usage

Papers has two key functions: import and cite.

To import, Papers searches arXiv and creates a new note with the paper metadata (paper title, authors, publication year, URL, and PDF). The search query can either be
1. arXiv URL: A direct link to the paper (e.g., https://arxiv.org/abs/1706.03762).
2. Title: The paper title, which is used to fuzzy search arXiv and prompt the user to choose among results.

To cite, Papers searches through the vault and creates a wikilink (with optional alias) to the imported paper note.
