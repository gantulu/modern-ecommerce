# ModernShop — E-commerce Platform

ModernShop is an e-commerce web application built with React, TypeScript, Vite, and Supabase. This repository contains the frontend application, Supabase-related database assets, and project documentation.

> **Project status:** The repository includes application code and database artifacts. A successful local build, deployed runtime, complete checkout flow, and production readiness must be verified separately; this README does not claim those checks have passed.

![ModernShop Banner](https://images.unsplash.com/photo-1523275335684-37898b6baf30?ixlib=rb-1.2.1&auto=format&fit=crop&w=1350&q=80)

## Overview

The project is intended to provide a responsive online-shopping experience, including product browsing, product details, cart interactions, account features, and order-related screens. Check the current source code and backend configuration to confirm the implementation status of individual features.

A previously configured demo URL is available at [ModernShop on Netlify](https://glittering-chimera-302e26.netlify.app). Its current availability and parity with this repository have not been verified here.

## Technology Stack

- **Frontend:** React 18, TypeScript, Vite
- **Routing:** React Router
- **State management:** Zustand
- **Styling:** Tailwind CSS
- **Icons:** Lucide React
- **Backend services:** Supabase, PostgreSQL
- **Hosting configuration:** Netlify configuration is present in the repository

## Prerequisites

- Node.js and npm
- A Supabase project for features that require backend services
- Supabase project URL and publishable/anon key for the frontend configuration

Use a currently supported Node.js LTS release where possible. The exact compatible runtime should be confirmed against the project and deployment configuration.

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/gantulu/modern-ecommerce.git
cd modern-ecommerce
```

### 2. Install dependencies

```bash
npm install
```

The repository defines a `postinstall` script that runs the build. If installation fails, inspect the build output and resolve the reported issue before proceeding.

### 3. Configure environment variables

Create a `.env` file in the project root with the frontend Supabase settings required by the source code:

```dotenv
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_publishable_or_anon_key
```

Use the exact variable names referenced by the application. Never place a Supabase service-role key, payment-provider secret, or other server-side credential in a `VITE_*` variable or frontend bundle.

### 4. Start the development server

```bash
npm run dev
```

Vite normally serves the development app at [http://localhost:5173](http://localhost:5173).

## Available Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Run TypeScript compilation and create a Vite production build |
| `npm run lint` | Run ESLint |
| `npm run preview` | Preview a local production build |
| `npm run check-migrations` | Run the repository's migration-check script |
| `npm run deploy` | Run the repository's deployment script; inspect its behavior and target before use |
| `npm test` | Currently a placeholder that prints “No tests specified”; it is **not** a meaningful application test suite |

Do not treat a successful `npm test` exit code as evidence that application behavior has been tested.

## Repository Structure

```text
src/                  Frontend application source
  components/         Reusable UI components
  lib/                Utilities and service clients
  pages/              Page components
  store/              Zustand stores
  types/              TypeScript types
supabase/
  migrations/         Database migration files
  consolidated/       Consolidated database assets, if present
docs/                 Database and migration documentation
scripts/              Repository maintenance and deployment scripts
```

This is a high-level guide. Confirm the actual directory contents and current implementation before relying on a path or feature.

## Database and Supabase

Database and migration-related documentation is available in:

- [Database schema](docs/DATABASE_SCHEMA.md)
- [Migration guide](docs/MIGRATION_GUIDE.md)
- [Migration issue notes](docs/MIGRATION_ISSUE.md)

These documents describe repository artifacts; they do not prove that migrations have been applied to a live Supabase project. Before applying migrations to any existing environment, review the SQL, check migration history and schema state, and confirm the target project. Do not run database changes against production without explicit authorization and a reviewed plan.

## Development and Verification

Before proposing a release, verify the relevant items independently:

- dependency installation and lockfile consistency;
- lint, TypeScript compilation, and production build;
- meaningful unit and integration tests (a real test suite is not currently configured by the `test` script);
- migration validity, schema constraints, grants, and Row Level Security;
- frontend-to-backend integration and error handling;
- payment-provider sandbox behavior, if payment integration is in scope;
- deployment configuration and actual runtime status.

Report tests as passed only when they have been run and their results observed. Repository files alone do not prove that a database migration, Edge Function, payment flow, or deployment is live and working.

## Contributing

1. Create a feature branch.
2. Keep changes scoped and reviewable.
3. Run the checks relevant to your changes.
4. Open a pull request describing the changes, verification performed, and any known limitations.

See [contribution guidelines](.github/CONTRIBUTING.md) if the file is present in the current branch.

## License

This project declares the MIT License. See [LICENSE](LICENSE) for the license text.

## Acknowledgments

- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [Supabase](https://supabase.com/docs)
- [Tailwind CSS](https://tailwindcss.com/)
- [Lucide](https://lucide.dev/)
- [Unsplash](https://unsplash.com/)
