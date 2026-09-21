"use client";

import { Badge } from "@bea/ui";
import type { DigitalWorkforceOrganizationNode } from "@bea/domain";
import { DIGITAL_AGENT_LABEL } from "@bea/domain";

import { directReports, workingStateTone } from "@/lib/digital-workforce";

export function DigitalWorkforceHierarchy({
  nodes,
  selectedAgentId,
  onSelect,
}: {
  readonly nodes: readonly DigitalWorkforceOrganizationNode[];
  readonly selectedAgentId: string | null;
  readonly onSelect: (agentId: string) => void;
}) {
  const roots = nodes
    .filter(
      (node) =>
        !node.supervisorAgentId || !nodes.some((item) => item.agentId === node.supervisorAgentId),
    )
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  function renderNode(node: DigitalWorkforceOrganizationNode, depth: number) {
    const reports = directReports(nodes, node.agentId);
    const selected = selectedAgentId === node.agentId;
    return (
      <li key={node.agentId}>
        <div
          className="bea-workforce-tree-row"
          style={{ paddingInlineStart: `${depth * 1.25}rem` }}
        >
          <button
            type="button"
            className="bea-workforce-tree-node"
            data-selected={selected ? "true" : "false"}
            data-testid={`workforce-agent-${node.agentId}`}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(node.agentId)}
          >
            <span className="bea-workforce-tree-name">{node.displayName}</span>
            <span className="bea-workforce-tree-role">{node.roleTitle}</span>
            <span className="bea-visually-hidden">{DIGITAL_AGENT_LABEL}</span>
            <Badge tone={workingStateTone(node.workingState)}>{node.workingState}</Badge>
            {node.supportedHumanDisplayName ? (
              <small>Supports {node.supportedHumanDisplayName} (association only)</small>
            ) : null}
            <small>
              {node.departmentName} · {node.teamName}
              {node.modelProfile ? ` · ${node.modelProfile}` : ""}
            </small>
          </button>
        </div>
        {reports.length > 0 ? (
          <ul className="bea-workforce-tree" aria-label={`Direct reports of ${node.displayName}`}>
            {reports.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  }

  if (roots.length === 0) {
    return <p>No Digital Agents are visible for the current role.</p>;
  }

  return (
    <ul
      className="bea-workforce-tree"
      aria-label="Digital Workforce hierarchy"
      data-testid="workforce-hierarchy"
    >
      {roots.map((node) => renderNode(node, 0))}
    </ul>
  );
}
