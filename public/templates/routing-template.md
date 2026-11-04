# Routing file

Upload this file to a project. Name real people and teams exactly as they appear in Jira. The AI only routes work to the names listed here.

## Teams

Team: Payments
Default person: Minh Tran
Members: Minh Tran, Linh Pham

Team: Platform
Default person: Huong Le
Members: Huong Le, Duc Nguyen

## People

- Minh Tran: backend engineer, payments
- Linh Pham: frontend engineer, payments
- Huong Le: tech lead, platform
- Duc Nguyen: DevOps, platform

## Rules

One rule per line. Each line states what the work touches and who takes it.

- Work that touches checkout or payment capture goes to the Payments team.
- Work that touches CI, deployment or infrastructure goes to Duc Nguyen.
- Anything about the design system goes to Linh Pham.
- Work that matches no rule goes to the Platform team's default person.
