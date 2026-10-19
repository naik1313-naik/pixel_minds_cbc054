"use client";

/**
 * Renders the assistant's minimal markdown.
 *
 * Deliberately tiny: **bold**, bullet lines, and paragraph breaks. The assistant
 * returns plain text with `**…**` markers rather than HTML, so there is no
 * `dangerouslySetInnerHTML` anywhere in this path and no way for a message to
 * become markup. A model or a database row cannot inject a tag through here.
 */
export default function AssistantText({ text, className = "" }: { text: string; className?: string }) {
  const blocks = text.split("\n");

  return (
    <div className={className}>
      {blocks.map((line, i) => {
        if (line.trim() === "") return <div key={i} className="h-2" />;

        if (line.startsWith("• ")) {
          return (
            <div key={i} className="flex gap-2 py-0.5">
              <span className="text-teal-400">•</span>
              <span className="flex-1">{bold(line.slice(2))}</span>
            </div>
          );
        }

        return <p key={i} className="py-0.5">{bold(line)}</p>;
      })}
    </div>
  );
}

function bold(line: string) {
  // Split on the marker and alternate; no element is ever built from raw HTML.
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold text-white">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}