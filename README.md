# Senderi

Senderi is a Facebook-like social platform in development. The first release is planned as a TypeScript MERN application for sharing posts, connecting with friends, and chatting in real time.

> **Project status:** Senderi is under active development. See the [milestones](doc/milestones.md) and [task checklist](doc/task-checklist.md) for implementation progress.

## Planned features

- Email and password signup, login, logout, and password reset through Brevo.
- Editable profiles with a bio, profile picture, and cover photo.
- Text and photo posts with **Public**, **Friends**, or **Only me** visibility.
- Mutual friendships through requests and acceptance.
- Likes, comments, and sharing of Public posts.
- One-to-one realtime text chat between accepted friends.
- Password hashing and application-level limits on login attempts and reset emails.

The first-release behavior and audience rules are defined in the [product requirements](doc/product-requirements.md).

## Planned stack

| Part | Technology |
| --- | --- |
| Web client | React, Vite, TypeScript, Tailwind CSS; deployed to Vercel |
| API and realtime chat | Node.js, Express, TypeScript, Socket.IO; deployed to Render |
| Application data | MongoDB Atlas |
| Images | Cloudinary |
| Password-reset email | Brevo |

See [Architecture and API](doc/architecture-api.md) for the service design and endpoint contracts. Deployment requirements and environment-variable names are in [Setup and deployment](doc/setup-deployment.md).

## Documentation and tasks

All detailed project documentation is indexed in [doc/README.md](doc/README.md). Start with:

1. [Milestones and assignments](doc/milestones.md) — the 34 reviewable work items and their owners.
2. [Task checklist](doc/task-checklist.md) — smaller steps for each work item.
3. [Task branch map](doc/branch-map.md) — the exact branch name for each task.
4. [Branch workflow](doc/branch-workflow.md) — pull requests, review, and release rules.

Jan and Laica each own complete features across the client, server, and tests. They review each other's pull requests. The 33 feature branches are starting points; update a branch from current `main` before its first task commit. The final release task uses a tag on `main` rather than a feature branch.

## Getting started

Install the client and server dependencies from the repository root with `npm ci --prefix client` and `npm ci --prefix server`. Create `server/.env` from `server/.env.example` and configure `MONGODB_URI`. Then run `npm run dev` from the root to start both services. Open `http://localhost:5173`; the API health check is at `http://localhost:3000/api/health`. See [Setup and deployment](doc/setup-deployment.md) for prerequisites and environment details.
