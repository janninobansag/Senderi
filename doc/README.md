# Senderi documentation

Senderi is a Facebook-like social platform planned as a TypeScript MERN application. This directory is the single home for project documentation. The first delivery is this documentation and roadmap; application code is scheduled in the milestones.

| Document | Purpose |
| --- | --- |
| [Product requirements](product-requirements.md) | First-release behavior, audience rules, and acceptance criteria |
| [Architecture and API](architecture-api.md) | Services, data model, REST contracts, and realtime message contract |
| [Milestones and assignments](milestones.md) | Feature breakdown, dependencies, owners, and exit checks |
| [Task checklist](task-checklist.md) | Small implementation steps and verification work for every milestone task |
| [Security](security.md) | Passwords, sessions, authorization, uploads, and abuse controls |
| [Setup and deployment](setup-deployment.md) | Planned local setup, environment variables, and free-tier deployment |
| [Branch workflow](branch-workflow.md) | Branch names, pull requests, reviews, and release process |
| [Task branch map](branch-map.md) | Exact GitHub branch name for each numbered task |

## Decisions for the first release

- Public email/password signup; no signup email verification.
- React with Vite and Tailwind on Vercel; Node.js and Express on Render; MongoDB Atlas for application data; Cloudinary for images; Brevo for password-reset email.
- Public posts are visible to **signed-in Senderi users**. Friends posts are visible to the author and accepted friends. Only me posts are visible to the author.
- One Like reaction. Only Public posts can be shared. Chat is one-to-one text between accepted friends.
- Jan and Laica own complete features across client, server, and tests, and review each other's pull requests.

The feature contracts in these documents guide implementation. The Express foundation for M0-J1 is now in `server/`; the client, remaining features, and deployments follow the milestones.
