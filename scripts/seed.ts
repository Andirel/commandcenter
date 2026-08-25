#!/usr/bin/env tsx
/**
 * Seed the database from config/*.yaml.
 *
 * Config is the source of truth for the bootstrap team model, so seeding
 * reconciles the database to it rather than the other way round.
 *
 * Reconciliation rules, which matter for re-running against a live database:
 *   - People and organizations are upserted by slug.
 *   - Capability edges seeded from config are marked `manually_confirmed`, so
 *     evidence accumulation records observations against them but never
 *     silently overwrites a human assertion.
 *   - Nothing is DELETED. Removing a person from config does not remove their
 *     history; deactivation is a deliberate act, not a side effect of an edit.
 */
import pg from 'pg';
import { loadConfig } from '../src/config/load.js';

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. See .env.example.');
    return 1;
  }

  const config = loadConfig();
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('begin');

    // --- capabilities -------------------------------------------------------
    for (const [name, def] of Object.entries(config.capabilities.capabilities)) {
      await client.query(
        `insert into capabilities (name, description, business_area, specialist_only)
         values ($1, $2, $3, $4)
         on conflict (name) do update
           set description = excluded.description,
               business_area = excluded.business_area,
               specialist_only = excluded.specialist_only`,
        [name, def.description ?? null, def.business_area ?? null, def.specialist_only],
      );
    }

    // --- organizations ------------------------------------------------------
    for (const [slug, org] of Object.entries(config.organizations.organizations)) {
      await client.query(
        `insert into organizations (slug, name, organization_type, importance, domains, notes)
         values ($1, $2, $3::organization_type, $4, $5, $6)
         on conflict (slug) do update
           set name = excluded.name,
               organization_type = excluded.organization_type,
               importance = excluded.importance,
               domains = excluded.domains,
               notes = excluded.notes`,
        [slug, org.name, org.type, org.importance, org.domains, org.notes.join(' ') || null],
      );
    }

    // --- people -------------------------------------------------------------
    const internalOrg = Object.entries(config.organizations.organizations)
      .find(([, o]) => o.type === 'internal')?.[0] ?? null;

    for (const [slug, person] of Object.entries(config.people.people)) {
      await client.query(
        `insert into people (slug, organization_id, name, email, slack_user_id, title,
                             relationship_type, internal_external, importance_score,
                             discovery_status, confidence, metadata, notes)
         values ($1,
                 (select id from organizations where slug = $2),
                 $3, $4, $5, $6, $7::relationship_type, $8::internal_external, $9,
                 $10::discovery_status, 1.0, $11::jsonb, $12)
         on conflict (slug) do update
           set name = excluded.name,
               title = excluded.title,
               importance_score = excluded.importance_score,
               discovery_status = excluded.discovery_status,
               metadata = excluded.metadata,
               notes = excluded.notes`,
        [
          slug,
          person.internal ? internalOrg : null,
          person.name,
          person.email ?? null,
          person.slack_user_id ?? null,
          person.role ?? null,
          person.relationship_type ?? (person.internal ? 'employee' : 'contractor'),
          person.internal ? 'internal' : 'external',
          person.importance,
          person.discovery_status,
          JSON.stringify({ aliases: person.aliases }),
          person.notes.join(' ') || null,
        ],
      );

      for (const [capability, edge] of Object.entries(person.capabilities)) {
        await client.query(
          `insert into person_capabilities
             (person_id, capability_id, confidence, proficiency, primary_secondary, manually_confirmed)
           values ((select id from people where slug = $1),
                   (select id from capabilities where name = $2),
                   $3, $4, $5::primary_secondary, $6)
           on conflict (person_id, capability_id) do update
             set confidence = excluded.confidence,
                 proficiency = excluded.proficiency,
                 primary_secondary = excluded.primary_secondary,
                 manually_confirmed = excluded.manually_confirmed`,
          [slug, capability, edge.confidence, edge.proficiency, edge.level, edge.confirmed],
        );
      }
    }

    // --- organization capabilities and relationship ownership ---------------
    for (const [slug, org] of Object.entries(config.organizations.organizations)) {
      const caps = Array.isArray(org.capabilities)
        ? Object.fromEntries(org.capabilities.map((c) => [c, { confidence: 0.7, proficiency: 0.7, level: 'primary', confirmed: false }]))
        : org.capabilities;

      for (const [capability, edge] of Object.entries(caps)) {
        // Agencies hold capabilities that no internal person has (google_ads,
        // podcast_sourcing). Insert the capability if it is new rather than
        // dropping the edge.
        await client.query(
          `insert into capabilities (name, specialist_only) values ($1, false)
           on conflict (name) do nothing`,
          [capability],
        );
        await client.query(
          `insert into organization_capabilities
             (organization_id, capability_id, confidence, proficiency, primary_secondary, manually_confirmed)
           values ((select id from organizations where slug = $1),
                   (select id from capabilities where name = $2),
                   $3, $4, $5::primary_secondary, $6)
           on conflict (organization_id, capability_id) do update
             set confidence = excluded.confidence,
                 proficiency = excluded.proficiency,
                 manually_confirmed = excluded.manually_confirmed`,
          [slug, capability, edge.confidence, edge.proficiency, edge.level, edge.confirmed],
        );
      }

      if (org.relationship_owner) {
        await client.query(
          `update organizations
              set relationship_owner_person_id = (select id from people where slug = $2)
            where slug = $1`,
          [slug, org.relationship_owner],
        );
      }
      if (org.execution_tracker) {
        await client.query(
          `update organizations
              set execution_tracker_person_id = (select id from people where slug = $2)
            where slug = $1`,
          [slug, org.execution_tracker],
        );
      }
    }

    await client.query('commit');

    const counts = await client.query<{ people: string; orgs: string; caps: string }>(`
      select (select count(*) from people) as people,
             (select count(*) from organizations) as orgs,
             (select count(*) from capabilities) as caps
    `);
    const row = counts.rows[0]!;
    console.log(`✓ seeded — ${row.people} people, ${row.orgs} organizations, ${row.caps} capabilities`);
    return 0;
  } catch (err) {
    await client.query('rollback');
    console.error(`\nSeed failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await client.end();
  }
}

process.exit(await main());
