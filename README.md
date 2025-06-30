# Papers for Obsidian

Papers is a simple plugin that retrieves and imports research papers into [Obsidian](https://obsidian.md). It queries the arXiv API to download PDFs and save metadata directly into your vault.

https://github.com/user-attachments/assets/12d1b2d4-46f9-416d-b1c7-95e07fae14b3

## Usage

Papers has one key function: search for a paper, then create a new note with its metadata. The search query can either be
1. arXiv URL: A direct link to the paper (e.g., https://arxiv.org/abs/1706.03762).
2. Title: The paper title, which is used to fuzzy search arXiv and prompt the user to choose among results.

The resulting note metadata includes paper title, authors, publication year, and URL. We can download the PDF and embed it in the note as well.
