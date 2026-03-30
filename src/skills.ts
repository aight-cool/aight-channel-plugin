// Skill Discovery — finds all Claude Code skills
//
// Three sources (in priority order, later overrides earlier):
//   1. AI-registered skills (via registerSkills()) — built-in + harness skills
//   2. Global:  ~/.claude/skills/<name>/SKILL.md
//   3. Project: <cwd>/.claude/skills/<name>/SKILL.md
//
// Parses YAML frontmatter for `name` and `description`.
// Project skills override global skills with the same name.

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SkillInfo {
  name: string;
  description: string;
  source: "project" | "global";
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts `name` and `description` fields using simple regex.
 * Handles both inline (`description: foo`) and multi-line (`description: |`)
 * YAML values.
 */
function parseFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1]!;
  const nameMatch = block.match(/^name:\s*(.+)$/m);

  if (!nameMatch?.[1]) return null;

  // Try inline description first, then multi-line YAML block scalar
  const inlineDesc = block.match(/^description:\s*(?![|>])(.+)$/m);
  let description = inlineDesc?.[1]?.trim() ?? "";

  if (!description) {
    // Multi-line: description: | or description: >
    // Grab the first indented line after the marker
    const multiLine = block.match(/^description:\s*[|>]-?\s*\n([ \t]+\S.*)$/m);
    if (multiLine?.[1]) {
      description = multiLine[1].trim();
    }
  }

  return {
    name: nameMatch[1].trim(),
    description,
  };
}

/**
 * Scan a skills directory and return discovered skills.
 */
function scanSkillsDir(
  baseDir: string,
  source: "project" | "global",
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const skillsDir = join(baseDir, ".claude", "skills");

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      // Follow symlinks — many skills are symlinked (e.g. gstack/)
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = statSync(join(skillsDir, entry.name)).isDirectory(); } catch {}
      }
      if (!isDir) continue;
      try {
        const content = readFileSync(
          join(skillsDir, entry.name, "SKILL.md"),
          "utf-8",
        );
        const meta = parseFrontmatter(content);
        if (meta) {
          skills.push({ name: meta.name, description: meta.description, source });
        }
      } catch {
        // SKILL.md doesn't exist or can't be read — skip
      }
    }
  } catch {
    // Skills directory doesn't exist — that's fine
  }

  return skills;
}

// Skills registered at runtime by the AI (built-in/harness skills
// that don't have SKILL.md files on disk).
let registeredSkills: SkillInfo[] = [];

/**
 * Register skills from the AI. Called when the AI sees the skills
 * list in the system-reminder and pushes them to the plugin.
 * Returns true if the set changed (caller should re-broadcast).
 */
export function registerSkills(skills: SkillInfo[]): boolean {
  const prev = JSON.stringify(registeredSkills.map((s) => s.name).sort());
  registeredSkills = skills;
  // Invalidate cache so next discoverSkills() picks them up
  cachedSkills = null;
  const next = JSON.stringify(registeredSkills.map((s) => s.name).sort());
  return prev !== next;
}

// Cache: re-scan at most once per 30 seconds to avoid
// repeated sync filesystem reads on reconnect storms.
let cachedSkills: SkillInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Discover all available Claude Code skills.
 *
 * Sources (in priority order, later overrides earlier):
 *   1. AI-registered skills — built-in/harness skills without SKILL.md files
 *   2. Global SKILL.md files (~/.claude/skills/)
 *   3. Project SKILL.md files (<cwd>/.claude/skills/)
 *
 * Results are cached for 30s to avoid repeated reads.
 */
export function discoverSkills(): SkillInfo[] {
  const now = Date.now();
  if (cachedSkills && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const globalSkills = scanSkillsDir(homedir(), "global");
  const projectSkills = scanSkillsDir(process.cwd(), "project");

  // Merge: registered first, then global, then project (later wins)
  const byName = new Map<string, SkillInfo>();
  for (const skill of registeredSkills) {
    byName.set(skill.name, skill);
  }
  for (const skill of globalSkills) {
    byName.set(skill.name, skill);
  }
  for (const skill of projectSkills) {
    byName.set(skill.name, skill);
  }

  cachedSkills = Array.from(byName.values());
  cacheTimestamp = now;
  return cachedSkills;
}
