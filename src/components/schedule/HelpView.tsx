import type { ReactNode } from "react";
import { cx } from "../../lib/classNames";

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <div className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200">
        {children}
      </div>
    </section>
  );
}

export default function HelpView() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            🩺 Shift Planner – Quick Guide
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Desktop overview of the most important features.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4">
        <Section title="1. Navigate Dates">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Use the left/right arrows above the calendar to move by week (by month in
              the monthly sheet layout). Click the date between the arrows to pick a week
              or month.
            </li>
            <li>
              Use <span className="font-medium">Today</span> to jump back to the
              current date.
            </li>
            <li>On phones the team plan shows one day at a time.</li>
          </ul>
        </Section>

        <Section title="2. Required Staffing & Open Slots">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Every slot of the <span className="font-medium">Weekly Calendar Template</span>{" "}
              (Settings) has a <span className="font-medium">Required</span> number, set
              separately for each weekday (Mon–Sun) and for holidays.
            </li>
            <li>
              Required places that nobody fills yet show as{" "}
              <span className="font-medium">Open Slots</span>. The{" "}
              <span className="font-medium">Open Slots</span> badge above the calendar
              counts them for the week; click it to jump to the next one.
            </li>
            <li>You can assign more people than required.</li>
          </ul>
        </Section>

        <Section title="3. Automated Planning (AI)">
          <p>
            The AI plans the selected timeframe day by day: on-call and priority slots
            first, every person with a contiguous block of work. It fills required
            slots only. Model and instructions are set in Settings → Solver Settings.
          </p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Automated planning panel
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                <li>
                  Choose the timeframe (<span className="font-medium">Current week</span>,{" "}
                  <span className="font-medium">Today</span> or your own dates), then click{" "}
                  <span className="font-medium">Run</span>.
                </li>
                <li>
                  While it runs you can watch the progress,{" "}
                  <span className="font-medium">Run in background</span>,{" "}
                  <span className="font-medium">Stop run</span> (the calendar stays as it
                  is) or <span className="font-medium">Apply best plan</span>.
                </li>
                <li>
                  When the run finishes, the run inbox opens (also behind the{" "}
                  <span className="font-medium">?</span> button of the panel). Review the
                  result and click <span className="font-medium">Apply</span> or{" "}
                  <span className="font-medium">Discard</span>. Nothing changes in the
                  calendar before you apply; a backup of the previous calendar is saved in
                  Snapshots first, and manual entries always stay.
                </li>
                <li>
                  <span className="font-medium">Reset</span> →{" "}
                  <span className="font-medium">Reset Solver Only</span> removes, in the
                  selected timeframe, only assignments made by the automated planner;{" "}
                  <span className="font-medium">Reset Unfixed</span> also removes manual
                  ones. Both keep fixed assignments and vacations.
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Pools & fixed assignments
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                <li>
                  <span className="font-medium">Rest Day Pool</span>: people
                  placed before or after on-call duties to rest.
                </li>
                <li>
                  <span className="font-medium">Vacation Pool</span>: people
                  on vacation are excluded from automatic allocation.
                </li>
                <li>
                  The <span className="font-medium">lock</span> button on a name the
                  automated planner placed fixes the assignment: replanning and both
                  Resets keep it. Click it again to unfix.
                </li>
                <li>
                  Names placed by hand show a small lock: replanning and Reset Solver
                  Only keep them, Reset Unfixed removes them.
                </li>
              </ul>
            </div>
          </div>
        </Section>

        <Section title="4. Manual Assignment">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Click a shift cell (not a name) to open the person picker. It lists
              everyone, best fits first, and warns about{" "}
              <span className="font-medium">Not qualified</span>,{" "}
              <span className="font-medium">On vacation</span>,{" "}
              <span className="font-medium">Rest day</span>,{" "}
              <span className="font-medium">Time conflict</span>,{" "}
              <span className="font-medium">Different location</span> and{" "}
              <span className="font-medium">Already in slot</span>.
            </li>
            <li>
              Drag a name to another shift or pool on the same day to move it. Dragging a
              person into the Vacation row marks that day as vacation (their shifts that
              day are removed); drag them from the Vacation row to another row on the same
              day to end the vacation.
            </li>
            <li>
              Drag a shift assignment out of the calendar to remove it.
            </li>
          </ul>
          <p className="mt-2">
            A shift assignment is also removed when you drop it on another day, on a
            shift whose time overlaps another of the person&apos;s shifts that day, or on
            an inactive cell (a shift that does not take place that day). Dropping it back
            on its own cell changes nothing. Qualification is not checked when you drop or
            pick a person: the assignment is kept and gets a yellow warning mark.
          </p>
        </Section>

        <Section title="5. Highlighting While Dragging">
          <ul className="list-disc space-y-1 pl-5">
            <li>While you drag a name, the other days are greyed out.</li>
            <li>
              On the same day, shifts the person is qualified for and free for get a dark
              outline.
            </li>
          </ul>
          <p className="mt-2">
            Qualifications are edited in Settings → People → Edit (Eligible Sections).
          </p>
        </Section>

        <Section title="6. Weekly Calendar Template (Settings)">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              The template defines the slots of every location, per weekday (Mon–Sun)
              and for holidays: add locations, rows and columns, then drag a section
              block into a cell or click an empty cell to add one.
            </li>
            <li>
              On a placed slot, click the time to set start and end, and the number to
              set how many people are required.
            </li>
            <li>
              <span className="font-medium">Copy Day</span> copies all columns and slots
              of one day to another. It replaces the target day&apos;s slots, so all shifts
              planned in them, including past weeks, are deleted.
            </li>
            <li>
              Removing a slot, block, row, column or location also deletes all shifts
              planned in it, including past weeks. The app asks for confirmation before
              removing anything that contains slots.
            </li>
          </ul>
        </Section>

        <Section title="7. Vacations">
          <p>
            Vacations remove people from scheduling for their vacation days. Manage
            them under Settings → People → Edit (Vacation periods), in the{" "}
            <span className="font-medium">Vacation Planner</span> below the calendar, or
            by dragging people into/out of the Vacation row.
          </p>
        </Section>

        <Section title="8. Holidays">
          <p>
            On a holiday the calendar uses the template&apos;s{" "}
            <span className="font-medium">Holiday</span> column instead of the weekday.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Holiday names appear under the date header.
            </li>
            <li>
              Holidays can be preloaded by country and year, and added/removed
              manually (date + name).
            </li>
          </ul>
        </Section>

        <Section title="9. Settings">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <span className="font-medium">Weekly Calendar Template</span>: locations,
              slots, required staffing and section blocks (see 6).
            </li>
            <li>
              <span className="font-medium">Calendar Layout</span>: standard weekly grid
              or the monthly sheet (Klinik-Monatslayout).
            </li>
            <li>
              <span className="font-medium">Solver Settings</span>: rules such as same
              location per day, the AI model, planning quality profile, AI agent
              instructions, section priority order and on-call rest days.
            </li>
            <li>
              <span className="font-medium">People</span>: add/edit/remove, eligible
              sections, vacations, preferred working times, work pattern and planning
              wishes for the AI. Removing a person also deletes their assignments.
            </li>
            <li>
              <span className="font-medium">Holidays</span>: preload, add/remove.
            </li>
          </ul>
        </Section>

        <Section title="10. Snapshots">
          <p>
            The <span className="font-medium">Calendar snapshots</span> button in the top
            bar saves the whole calendar under a name and restores it later. Before a
            restore, and before a planning result is applied, the current calendar is
            saved as an automatic backup.
          </p>
          <p className="mt-2">
            Settings → <span className="font-medium">Schedule snapshot</span> downloads the
            assignments as a file and imports them again.
          </p>
        </Section>

        <Section title="11. Export: PDF, iCal & Web">
          <p>
            <span className="font-medium">Open Export</span> below the calendar.{" "}
            <span className="font-medium">PDF</span> creates printable week exports, either in
            landscape with the times side by side or in portrait as the compact week (Times:
            Stacked);{" "}
            <span className="font-medium">Web</span> creates a read-only public view link.
          </p>
          <p className="mt-2">
            You can download your schedule as an <span className="font-medium">iCal</span>{" "}
            file (<span className="font-medium">.ics</span>) or publish a subscribe link
            for calendar apps (Google Calendar, Apple Calendar, Outlook).
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              A single <span className="font-medium">.ics</span> file can contain{" "}
              <span className="font-medium">multiple events across many dates</span>.
            </li>
            <li>
              In <span className="font-medium">Download</span>, you can export either{" "}
              <span className="font-medium">one file for all people</span> or{" "}
              <span className="font-medium">individual files per person</span>.
            </li>
            <li>
              In <span className="font-medium">Subscribe / Publish</span>, you can publish a
              read-only link (anyone with the link can subscribe), rotate the link, or unpublish it.
            </li>
            <li>
              Subscriptions include only weeks marked{" "}
              <span className="font-medium">Published</span> in the schedule view.
            </li>
            <li>
              When published, you get one link for{" "}
              <span className="font-medium">all people</span> and one link per person.
            </li>
          </ul>
        </Section>

        <Section title="12. My plan">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Use <span className="font-medium">Team | My plan</span> at the top left of the
              calendar to switch between the whole team and your own shifts. The date stays
              the same.
            </li>
            <li>
              The first time, pick yourself under{" "}
              <span className="font-medium">I am</span> and click{" "}
              <span className="font-medium">That's me</span>. The arrow next to the switch
              opens another person's plan.
            </li>
            <li>
              Choose <span className="font-medium">Day</span>,{" "}
              <span className="font-medium">Week</span> or{" "}
              <span className="font-medium">Month</span>, and{" "}
              <span className="font-medium">Date on top</span> (days side by side, calendar)
              or <span className="font-medium">Date on left</span> (days stacked, list).
              The choice is remembered per range; phones keep their own range and choices.
            </li>
            <li>
              Click a shift for its details (hours, who works with you, rest before).{" "}
              <span className="font-medium">Show in team plan</span> opens the team view at
              that date and briefly highlights your entry.
            </li>
            <li>
              The <span className="font-medium">star</span> makes the current view your start
              page on this device type (computer or phone);{" "}
              <span className="font-medium">Views</span> saves views by name. Views never
              store a date.
            </li>
            <li>
              Keyboard in My plan (not while typing): T / W / M day, week, month · H today ·
              O date on top / left · P team plan · N / Shift+N next / previous shift · ?
              lists the shortcuts.
            </li>
            <li>
              <span className="font-medium">Times: Stacked</span> (team plan, standard weekly
              grid) shows one column per day and a day&rsquo;s times as rows below each other.
              The left column names each row and its time and carries the workplace&rsquo;s color;
              the cells show only the people (names shorten to initials in narrow columns). A
              cell writes its own time only where it differs from its row; a{" "}
              <span className="font-medium">+N</span> next to a row name means some days belong
              to another workplace (hover it, or a cell, to see which).{" "}
              <span className="font-medium">Side by side</span> gives every time of a day its
              own column, as before.
            </li>
            <li>
              <span className="font-medium">Color by: Person</span> (team plan, standard
              weekly grid) gives every person their own color. Once you have linked yourself
              (&ldquo;That&rsquo;s me&rdquo;), your own entries also get an outline. The
              monthly sheet layout keeps its look.
            </li>
          </ul>
          <p className="mt-2">
            Team | My plan, range, date on top / left, Times, Color by, saved views and start
            pages are saved per account and never change the shared calendar.
          </p>
          <p className="mt-2">
            <span className="font-medium">Location colors</span> are different: they are part
            of the shared calendar, so every planner sees them. Pick one next to a location's
            name in Settings → Weekly Calendar Template. My plan tints each day by the
            location where a shift starts; the standard weekly grid tints that location's row
            labels and its location header.
          </p>
        </Section>
      </div>

      <div
        className={cx(
          "mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-xs text-slate-500",
          "dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400",
        )}
      >
        Your changes are saved to the server so they remain after reloading the
        page.
      </div>
    </div>
  );
}
