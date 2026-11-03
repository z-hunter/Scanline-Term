# Scanline Term Agent Rules

<RULE>
Before beginning work on any task in this repository, you MUST read the `AGENT_GUIDE.md` file located at the root of the project. It contains vital instructions for coding agents, including:
- Inspection checklists
- Warnings about high-risk files (like `CRTFilter.ts` and `App.tsx`)
- Safe editing practices
- A change impact map
- Specific testing requirements for Tauri/Rust vs Frontend code

Do not skip reading `AGENT_GUIDE.md` as it is essential for preventing regressions in this codebase.
</RULE>

## Xerj Usage

- For code in this project, use `xerj_search` with a plain-string query first; it returns definition-first code passages from the local project index. Keep results focused and verify relevant files in the checkout before editing.
- Use `xerj_code_search` for reference coding against its named peer-project corpus, not as a substitute for searching this project's local index. Use it when an unfamiliar implementation pattern would benefit from examples in other repositories; heed its licence warnings.
- Use `xerj_map` before structured queries to learn actual index fields. Use semantic or hybrid search when the question is phrased by meaning and lexical search is insufficient; use `xerj_plan` for filters expressible in plain language.
- Use graph overview/neighborhood tools when relationships among indexed project documents or code references help answer the question. Treat detected links as lexical evidence, not proof of semantic relationships.
- Keep queries and returned passages narrow to limit context use. Refresh the project index after substantial code or documentation changes when current search results matter; `autoindex` is incremental.
- Do not use Xerj's memory tools for durable agent memory. `agent_memory` remains the project's memory system.
- Do not enable external reranking unless the user explicitly wants it: it sends retrieved document text to an external provider.
