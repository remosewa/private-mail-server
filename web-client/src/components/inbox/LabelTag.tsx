import type { Label } from '../../store/labelStore';

interface Props {
  label: Label;
}

/**
 * LabelTag — displays a label as a colored tag with tooltip.
 * 
 * Reusable component for inbox and thread views that shows a label
 * with its custom color background and name. Includes a tooltip on
 * hover showing the full label name (useful when truncated).
 * 
 * Requirements: 3.1, 3.2, 3.3, 10.1
 */
export default function LabelTag({ label }: Props) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium
                 text-white shadow-sm transition-opacity hover:opacity-90"
      style={{ backgroundColor: label.color }}
      title={label.name}
    >
      {label.name}
    </span>
  );
}
