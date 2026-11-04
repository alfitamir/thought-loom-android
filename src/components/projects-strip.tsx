import { Link } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { projectOptions, type Idea } from "@/lib/ideas";

/**
 * «المشاريع»: the discovery strip for one partition's projects — every
 * project name in use in the given ideas, with its article count, each
 * leading to that project's own view. Projects are derived from
 * assignments (no registry), so the strip renders only when at least
 * one project exists in this section; the same name in the other
 * section is a different project and never appears here.
 */
export function ProjectsStrip({ ideas, medical = false }: { ideas: Idea[]; medical?: boolean }) {
  const projects = projectOptions(ideas);
  if (!projects.length) return null;
  return (
    <div className="mb-5">
      <p className="mb-2 flex items-center gap-1.5 font-display text-lg text-foreground">
        <FolderOpen className="size-5 text-primary" />المشاريع
      </p>
      <div className="flex flex-wrap gap-2">
        {projects.map(({ project, count }) => (
          <Link
            key={project}
            to="/project"
            search={medical ? { project, section: "medical" as const } : { project }}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            {project}
            <span className="text-xs text-muted-foreground">{count}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
