// Skill Discovery — finds Claude Code skills from SKILL.md files
//
// Scans two locations:
//   1. Project: <cwd>/.claude/skills/<name>/SKILL.md
//   2. Global:  ~/.claude/skills/<name>/SKILL.md
//
// Parses YAML frontmatter for `name` and `description`.
// Project skills override global skills with the same name.

import { readdirSync, readFileSync } from "fs";
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
 */
function parseFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*(.+)$/m);

  if (!nameMatch) return null;

  return {
    name: nameMatch[1].trim(),
    description: descMatch ? descMatch[1].trim() : "",
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
      if (!entry.isDirectory()) continue;
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

// Cache: re-scan at most once per 30 seconds to avoid
// repeated sync filesystem reads on reconnect storms.
let cachedSkills: SkillInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Discover all available Claude Code skills.
 * Project skills override global skills with the same name.
 * Results are cached for 30s to avoid repeated filesystem reads.
 */
export function discoverSkills(): SkillInfo[] {
  const now = Date.now();
  if (cachedSkills && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSkills;
  }

  const globalSkills = scanSkillsDir(homedir(), "global");
  const projectSkills = scanSkillsDir(process.cwd(), "project");

  // Dedup: project overrides global
  const byName = new Map<string, SkillInfo>();
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
