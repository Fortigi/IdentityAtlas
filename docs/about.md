# About

## Creators

Identity Atlas is created by **[Maatschap Fortigi](https://www.fortigi.nl)**, a Dutch identity and access management consultancy based in the Netherlands.

**Lead developer:** [Wim van den Heijkant](https://www.linkedin.com/in/wimvdheijkant/) — architect and maintainer since the original FortigiGraph PowerShell toolkit in 2022.

Fortigi specialises in identity governance, privileged access, and Microsoft Entra ID deployments for enterprise customers across Europe. Identity Atlas started as an internal tool and grew into the product you're looking at.

## What is Identity Atlas?

Identity Atlas is a universal authorization intelligence platform. It pulls permission data from every system that holds authorization decisions — Entra ID, SAP, SharePoint, ServiceNow, custom applications — into a single PostgreSQL data model. On top of that model it provides:

- A **role-mining matrix view** for analysts reviewing access
- **LLM-assisted risk scoring** that tailors itself to your organisation and industry
- **Full audit history** at the row level via postgres triggers
- **CSV imports** with a canonical schema so any source system can be onboarded with a short pre-import transform

See the [History](history.md) page for the full story of how Identity Atlas got to where it is today.

## Contact

- **Website:** [www.fortigi.nl](https://www.fortigi.nl)
- **Issues and pull requests:** [GitHub repository](https://github.com/Fortigi/IdentityAtlas)

## License

Copyright © Maatschap Fortigi. See the repository `LICENSE` file for licensing terms.
