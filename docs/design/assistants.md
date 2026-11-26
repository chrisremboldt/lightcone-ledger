# Assistants

Ledger records and checks. It calls no language model, and no finding, evaluation result or decision comes from one. This note says where an assistant fits, and why the seam that once sat inside the API was taken out.

## What was decided

- **An assistant is the operator's own, outside Ledger.** It may be a coding agent on the operator's computer or any other program the operator chooses. Ledger does not ship one, start one or call one.
- **It reads through the same doors a person's tools use.** The command-line client (`pnpm ledger`) gives it every reading command and check. An agent that speaks the Model Context Protocol uses the same commands as tools through the client's MCP server (`pnpm ledger mcp`, described in [AGENTS.md](../../AGENTS.md#an-agent-that-speaks-mcp)): each tool calls the function its command calls, so there is one implementation of each command and two ways to call it. Both run under the client's own credential and the capabilities it holds, and read no more than that credential can.
- **It never sends a decision.** Where the client lets an agent's credential send something (importing records), the agent may. Where the client prepares a decision for a person to send with their own credential and reason (an adoption, a grant, a signature, taking or closing findings), the agent prepares it and the person runs the command. A tool for such a decision returns what the client prints and the command the person runs. No tool takes a person's credential or reason, and the server refuses any argument a tool does not describe.
- **It reads nothing restricted.** No reading command returns the content of a safety report, so no assistant gets it through the client or its tools.

## Why the seam was removed

The API had a seam for an assistant that would draft an investigation proposal about one finding a person was reviewing, with a placeholder package that refused every request. Nothing implemented it. Its context and its citations were written for one kind of finding, the command-link status of a flight, so an implementation could have served only that one rule; making it serve any rule would have meant a second, parallel description of what a finding rests on.

What the seam would have handed an assistant is already readable: a finding, the evaluations behind it, the records they read and what is not on file. The client reads it for any finding of any rule (`pnpm ledger findings show`), and the MCP server offers the same read as the `show_finding` tool. Keeping an assistant outside Ledger also keeps the doctrine simple to state and to check: nothing in this codebase calls a model.

## What was considered

- **Making the seam's context generic**, so that an implementation could be written for any rule. That keeps a model-calling path inside the API, with its own limits, transport and failure modes, for an assistant nobody had written, and it would still be Ledger choosing and running the assistant.
- **Leaving the placeholder in place.** It cost a route, a package, a transport and their tests, and it told every reader that Ledger might one day call a model.
