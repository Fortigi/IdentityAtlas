---
type: concept
prereq: risk-scoring/overview.md
outcome: You know which accounts count as non-human and how their risk score is calculated.
---

# AI Agents & Non-Human Identities

!!! info "Before this page"
    Assumes you have read **[How Scoring Works](./overview.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

Not every account belongs to a person. Applications, automation and AI agents hold access too, and nobody reviews them the way they review a colleague. Identity Atlas stores them as accounts with their own type, so you can tell them apart and score them with their own classifiers.

## Account types for non-human identities

| Type (`principalType`) | What it is |
|---|---|
| `ServicePrincipal` | An application's identity in the directory |
| `ManagedIdentity` | An identity attached to a cloud resource and managed by the platform |
| `AIAgent` | A service principal recognised as an AI agent |
| `WorkloadIdentity` | An identity for a workload that signs in with a federated credential |

## How the Entra ID crawler decides the type

For each service principal, the first rule that applies wins:

1. Entra ID marks it as a managed identity → `ManagedIdentity`.
2. It carries one of the tags `CopilotStudio`, `PowerVirtualAgents`, `AzureOpenAI`, `CognitiveServices`, `AgenticInstance` or `AgenticApp`, or a tag that starts with `power-virtual-agents-` → `AIAgent`.
3. Its display name contains `copilot`, `openai`, `azure-ai` or `cognitive-service`, or the separate word `gpt` or `bot` → `AIAgent`.
4. Otherwise → `ServicePrincipal`.

The Entra ID crawler does not assign `WorkloadIdentity`. The CSV and SQL crawlers accept all four types, so a source that knows the difference can supply it.

Rule 3 is a name match, so check the outcome: an application called *Robot Arm Bot* becomes an `AIAgent`, and an agent with a neutral name stays a `ServicePrincipal`.

## How they are scored

Non-human accounts go through the same four layers as every other account. One thing differs:

- **Layer 1 uses the Agents classifiers.** Accounts of the four types above are matched against the **Agents** tab of the active classifier set. If the set contains no agent classifiers, the **Users** classifiers are used instead.

Layers 2 to 4 are identical for human and non-human accounts: the same membership, hygiene and propagation signals, with the same points. There is no extra score for being non-human.

To see the agent classifiers, open **Admin → Risk Scoring**, expand **Risk Classifiers** and choose the **Agents** tab. See [Classifiers](./classifiers.md).
