/** A unified diff with added and removed lines coloured. */
export function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split("\n").map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "meta"
          : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
        return <span key={i} className={`diff-line ${kind}`}>{line || " "}{"\n"}</span>;
      })}
    </pre>
  );
}
