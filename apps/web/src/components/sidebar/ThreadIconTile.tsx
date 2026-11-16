import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";

import { cn } from "~/lib/utils";

const ICON_NAMES: ReadonlySet<string> = new Set(iconNames);

// The tint comes from the thread id, so neighboring threads usually differ.
const TINTS = [
  "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  "bg-teal-500/12 text-teal-700 dark:text-teal-300",
] as const;

function tintFor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length]!;
}

/**
 * The thread's icon, picked with its title, so a thread is recognized without reading.
 * A thread titled before icons existed shows its title's first letter until it is retitled.
 * The dot carries the row's status, which the icon rail otherwise hides.
 */
export function ThreadIconTile(props: {
  readonly threadId: string;
  readonly icon: string | null;
  readonly title: string;
  readonly statusClassName: string | null;
}) {
  const icon = props.icon !== null && ICON_NAMES.has(props.icon) ? (props.icon as IconName) : null;
  return (
    <span
      aria-hidden
      data-thread-icon=""
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-lg",
        tintFor(props.threadId),
      )}
    >
      {icon !== null ? (
        <DynamicIcon name={icon} className="size-4.5" />
      ) : (
        <span className="text-sm font-semibold">
          {props.title.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "#"}
        </span>
      )}
      {props.statusClassName !== null ? (
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-current ring-2 ring-sidebar",
            props.statusClassName,
          )}
        />
      ) : null}
    </span>
  );
}
