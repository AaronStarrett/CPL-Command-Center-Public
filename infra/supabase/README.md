# Supabase pilot templates

Supabase is the recommended initial managed PostgreSQL data plane. These files are not linked to a project and do not provision or migrate a database.

- Run the repository's standard PostgreSQL migrations with a dedicated migration connection.
- Enable the PostgreSQL `vector` extension only when semantic-memory tables are introduced.
- Use direct IPv6 or Supavisor session mode for persistent containers; use transaction pooling only where its transaction semantics are acceptable.
- Keep application identity IDs separate from Supabase Auth subjects.
- Enforce tenant predicates server-side and add/test PostgreSQL row-level-security as defense in depth before customer data.
- Export with standard `pg_dump` and verify restores to preserve provider portability.

The SQL example is intentionally non-executable by the existing migration runner.
