# graphlagoon-studio Developer Documentation

## Overview

This directory contains comprehensive technical documentation for the graphlagoon-studio project. The documentation is designed to help developers understand the architecture, debug issues, implement features, and maintain code quality.

## Quick Navigation

### 📚 Core Documentation

| Document | Purpose | When to Use |
|----------|---------|-------------|
| [architecture.md](architecture.md) | System architecture and component overview | Understanding the overall system design |
| [code_patterns.md](code_patterns.md) | Coding conventions and best practices | Writing new code or refactoring |
| [technical_debts.md](technical_debts.md) | Known technical debts and areas for improvement | Planning refactoring or avoiding known issues |
| [potential_bugs.md](potential_bugs.md) | Cataloged potential bugs and edge cases | Understanding known issues or reproducing bugs |
| [decision_log.md](decision_log.md) | Historical record of all significant decisions | Understanding why decisions were made |

### 🛠️ Skills and Workflows

| Skill Document | Purpose | When to Use |
|----------------|---------|-------------|
| [skill_frontend_debugging.md](skill_frontend_debugging.md) | Frontend debugging workflow | Fixing bugs in Vue 3 application |
| [skill_backend_debugging.md](skill_backend_debugging.md) | Backend debugging workflow | Fixing bugs in FastAPI application |
| [skill_feature_creation.md](skill_feature_creation.md) | Feature development workflow | Implementing new features |

## Document Descriptions

### [architecture.md](architecture.md)

**Comprehensive system architecture documentation including:**
- High-level architecture overview
- Frontend architecture (Vue 3, Pinia, Sigma.js, Three.js)
- Backend architecture (FastAPI, SQLAlchemy, PostgreSQL)
- SQL Warehouse integration (Spark SQL, Databricks)
- Data flow diagrams
- Persistence modes (localStorage vs. PostgreSQL)
- Databricks integration
- Cypher-to-SQL transpilation
- API endpoints reference
- Configuration guide
- Deployment modes

**Use this when:**
- Onboarding new developers
- Understanding how components interact
- Planning architectural changes
- Debugging integration issues

### [code_patterns.md](code_patterns.md)

**Coding patterns and conventions including:**
- Frontend patterns (Vue Composition API, Pinia stores, TypeScript)
- Backend patterns (FastAPI routers, SQLAlchemy models, Pydantic schemas)
- Error handling patterns
- Async/await patterns
- Testing patterns
- Naming conventions
- File organization
- Documentation standards

**Use this when:**
- Writing new code
- Reviewing code
- Ensuring consistency
- Setting up development environment

### [technical_debts.md](technical_debts.md)

**Cataloged technical debts with priority levels:**
- Frontend debts (large store file, dual persistence complexity, missing tests)
- Backend debts (database pooling, SQL injection risks, missing caching)
- Shared debts (naming inconsistency, missing documentation)
- Architecture debts (missing domain layer)
- Performance debts (no pagination, continuous layout)
- Prioritization recommendations

**Use this when:**
- Planning refactoring sprints
- Understanding known issues
- Avoiding problematic patterns
- Prioritizing improvement work

### [potential_bugs.md](potential_bugs.md)

**Cataloged potential bugs and edge cases:**
- Frontend bugs (race conditions, memory leaks, reactivity issues)
- Backend bugs (SQL errors, auth issues, timeout problems)
- Integration bugs (transpilation errors, token expiration)
- Edge cases (empty graphs, special characters, self-loops)
- Testing recommendations
- Reproduction steps

**Use this when:**
- Debugging issues
- Understanding known problems
- Writing regression tests
- Avoiding common pitfalls

### [decision_log.md](decision_log.md)

**Historical record of all decisions including:**
- Templates for bug fixes, features, architectural decisions
- Chronological log of all significant changes
- Rationale for design decisions
- Alternatives considered and rejected
- Cross-references to related documents

**Use this when:**
- Understanding why something was done a certain way
- Making similar decisions
- Documenting new work
- Reviewing historical context

### [skill_frontend_debugging.md](skill_frontend_debugging.md)

**Step-by-step frontend debugging workflow:**
- Reproducing issues
- Identifying components
- Using browser DevTools and Vue DevTools
- Common frontend issues (rendering, filters, performance, API errors)
- Testing fixes
- Documenting in decision log

**Use this when:**
- Fixing frontend bugs
- Performance issues in visualization
- State management problems
- API integration issues

### [skill_backend_debugging.md](skill_backend_debugging.md)

**Step-by-step backend debugging workflow:**
- Reproducing issues
- Enabling debug logging
- Common backend issues (database, queries, auth, Databricks integration)
- Testing fixes with pytest
- Performance debugging
- Documenting in decision log

**Use this when:**
- Fixing backend bugs
- Database issues
- Query execution problems
- API errors
- Databricks integration issues

### [skill_feature_creation.md](skill_feature_creation.md)

**Complete feature development workflow:**
- Planning and design phase
- Requirements definition
- Architecture decisions
- Backend implementation (models, services, routers)
- Frontend implementation (components, stores, types)
- Testing strategy
- Documentation requirements
- Pull request process

**Use this when:**
- Implementing new features
- Adding functionality
- Making significant changes
- Need end-to-end development guide

## Getting Started

### For New Developers

1. **Read in this order:**
   1. [README.md](README.md) (this file)
   2. [architecture.md](architecture.md) - Understand the system
   3. [code_patterns.md](code_patterns.md) - Learn the conventions
   4. [technical_debts.md](technical_debts.md) - Know what to avoid

2. **Keep handy:**
   - [skill_frontend_debugging.md](skill_frontend_debugging.md)
   - [skill_backend_debugging.md](skill_backend_debugging.md)
   - [skill_feature_creation.md](skill_feature_creation.md)

3. **Always update:**
   - [decision_log.md](decision_log.md) for every significant change

### For Debugging

1. **Frontend Issue:**
   - Follow [skill_frontend_debugging.md](skill_frontend_debugging.md)
   - Check [potential_bugs.md](potential_bugs.md) for known issues
   - Refer to [code_patterns.md](code_patterns.md) for patterns

2. **Backend Issue:**
   - Follow [skill_backend_debugging.md](skill_backend_debugging.md)
   - Check [potential_bugs.md](potential_bugs.md) for known issues
   - Refer to [code_patterns.md](code_patterns.md) for patterns

3. **After Fixing:**
   - Update [decision_log.md](decision_log.md)
   - Consider updating [potential_bugs.md](potential_bugs.md) if new edge case discovered

### For Implementing Features

1. **Before Starting:**
   - Review [architecture.md](architecture.md) to understand where feature fits
   - Check [technical_debts.md](technical_debts.md) for related issues
   - Check [decision_log.md](decision_log.md) for related past decisions

2. **During Implementation:**
   - Follow [skill_feature_creation.md](skill_feature_creation.md)
   - Follow patterns from [code_patterns.md](code_patterns.md)
   - Document design decisions as you go

3. **After Implementation:**
   - Update [decision_log.md](decision_log.md) with comprehensive entry
   - Update [architecture.md](architecture.md) if architecture changed
   - Update [code_patterns.md](code_patterns.md) if new pattern introduced

## Important Notes

### Decision Log is Mandatory

**ALL actions using the skill documents MUST be logged in [decision_log.md](decision_log.md).**

This includes:
- Bug fixes (use Bug Fix template)
- Feature implementations (use Feature Implementation template)
- Architectural changes (use Architectural Decision template)
- Refactorings (use Refactoring template)
- Performance optimizations (use Performance Optimization template)

### Keeping Documentation Updated

These documents are living documents and should be updated when:

- **architecture.md:** Major architectural changes, new components, data flow changes
- **code_patterns.md:** New patterns introduced, conventions changed
- **technical_debts.md:** New debts identified, debts resolved
- **potential_bugs.md:** New bugs discovered, bugs fixed, edge cases found
- **decision_log.md:** ALWAYS - for every significant change

### Cross-References

Documents reference each other extensively. Use the references to:
- Understand context
- Find related information
- Trace decisions
- See complete picture

## Project Structure

```
graphlagoon-studio/
├── graphlagoon-frontend/       # Vue 3 frontend application
│   ├── src/
│   │   ├── components/        # UI components
│   │   ├── stores/            # Pinia stores
│   │   ├── services/          # API client, utilities
│   │   ├── views/             # Page components
│   │   └── ...
│   └── package.json
├── graphlagoon-rest-api/       # FastAPI backend application
│   ├── graphlagoon/
│   │   ├── routers/           # API endpoints
│   │   ├── services/          # Business logic
│   │   ├── db/                # Database models
│   │   ├── models/            # Pydantic schemas
│   │   └── ...
│   └── pyproject.toml
├── sql-warehouse/             # Mock Spark SQL warehouse (dev only)
└── docs_help_dev/             # This documentation directory
    ├── README.md              # This file
    ├── architecture.md
    ├── code_patterns.md
    ├── technical_debts.md
    ├── potential_bugs.md
    ├── decision_log.md
    ├── skill_frontend_debugging.md
    ├── skill_backend_debugging.md
    └── skill_feature_creation.md
```

## Key Technologies

### Frontend
- **Vue 3** - UI framework
- **Vite** - Build tool
- **Pinia** - State management
- **TypeScript** - Type safety
- **Sigma.js** - 2D graph rendering
- **3D Force Graph** - 3D graph visualization
- **Graphology** - Graph data structure

### Backend
- **FastAPI** - Web framework
- **SQLAlchemy 2.0** - ORM with async support
- **PostgreSQL** - Database
- **Pydantic 2.0** - Data validation
- **httpx** - Async HTTP client
- **gsql2rsql** - Cypher to SQL transpiler

### Infrastructure
- **Docker** - PostgreSQL containerization
- **Alembic** - Database migrations
- **Databricks** - Production SQL warehouse (optional)

## Development Workflow

### Quick Reference

```bash
# Frontend development
cd graphlagoon-frontend
npm install
npm run dev

# Backend development
cd graphlagoon-rest-api
pip install -e .
uvicorn graphlagoon.main:app --reload

# Database
docker-compose up -d postgres
alembic upgrade head

# Testing
pytest                          # Backend tests
npm run test                    # Frontend tests (when implemented)
```

## Contributing

1. **Before making changes:**
   - Read relevant documentation
   - Check decision log for context
   - Plan your approach

2. **While making changes:**
   - Follow code patterns
   - Document decisions
   - Write tests

3. **After making changes:**
   - Update decision log (MANDATORY)
   - Update other docs if needed
   - Create pull request

## Getting Help

1. **Search documentation:**
   - Use this README to find relevant doc
   - Use Ctrl+F to search within documents

2. **Check decision log:**
   - May answer "why" questions
   - Shows historical context

3. **Review code:**
   - Look for similar patterns
   - Follow established conventions

4. **Ask team:**
   - With context from documentation
   - Document the answer in decision log

## Maintenance

### Regular Reviews

Periodically review and update:
- **Monthly:** Review technical debts, prioritize fixes
- **Quarterly:** Review architecture doc for accuracy
- **After major features:** Update all relevant docs
- **Before releases:** Review potential bugs, ensure critical issues addressed

### Quality Checks

- Documentation is accurate and up-to-date
- Decision log captures all significant changes
- Cross-references are valid
- Code patterns reflect current codebase
- Technical debts list is current

## License

This documentation is part of the graphlagoon-studio project and follows the same license.

## Contact

For questions about this documentation:
1. Check the decision log first
2. Review the relevant skill document
3. Ask the team with specific questions

---

**Remember:** Good documentation saves time and prevents mistakes. Always keep it updated!
