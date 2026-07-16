"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  ListTodo,
  Plus,
  Radio,
  RefreshCw,
  Repeat2,
  Share2,
  Sparkles,
} from "lucide-react";
import styles from "@/app/schedule/schedule.module.css";

type TodoList = {
  id: string;
  name: string;
  visibility: "private" | "project";
  revision: number;
  archived_at: string | null;
};

type Todo = {
  id: string;
  list_id: string;
  parent_todo_id: string | null;
  title: string;
  plain_text: string;
  status: "open" | "completed" | "canceled";
  assignee: { principal_id: string; display_name: string; kind: "human" | "agent" } | null;
  starts_at: string | null;
  due_at: string | null;
  time_zone: string;
  revision: number;
  archived_at: string | null;
};

type Calendar = {
  id: string;
  name: string;
  visibility: "private" | "project";
  time_zone: string;
  revision: number;
};

type CalendarItem = {
  id: string;
  source: "calendar_entry" | "todo_start" | "todo_due" | "issue_start" | "issue_due";
  source_id: string;
  calendar_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  time_zone: string;
};

type Reminder = {
  id: string;
  todo_id: string | null;
  calendar_entry_id: string | null;
  recipient_principal_id: string;
  remind_at: string;
  state: string;
  delivery_channel: string;
};

type Envelope<T> = { data: T; error?: { message?: string } };
type Mode = "todos" | "calendar";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  return payload.data;
}

function key(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function localInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function iso(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function document(text: string) {
  return {
    type: "doc",
    content: text.trim()
      ? [{ type: "paragraph", content: [{ type: "text", text: text.trim() }] }]
      : [],
  };
}

function formatWhen(value: string | null) {
  if (!value) return "Unscheduled";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ScheduleWorkspace({ workspaceId, projectId }: { workspaceId?: string; projectId?: string }) {
  const [mode, setMode] = useState<Mode>("todos");
  const [lists, setLists] = useState<TodoList[]>([]);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [calendarItems, setCalendarItems] = useState<CalendarItem[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [newListName, setNewListName] = useState("");
  const [newListVisibility, setNewListVisibility] = useState<"private" | "project">("private");
  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [newTodoBody, setNewTodoBody] = useState("");
  const [newTodoDue, setNewTodoDue] = useState("");
  const [newCalendarName, setNewCalendarName] = useState("");
  const [entryTitle, setEntryTitle] = useState("");
  const [entryStart, setEntryStart] = useState(() => localInput(new Date(Date.now() + 60 * 60_000)));
  const [entryEnd, setEntryEnd] = useState(() => localInput(new Date(Date.now() + 2 * 60 * 60_000)));
  const [reminderRecipient, setReminderRecipient] = useState("");
  const [reminderAt, setReminderAt] = useState(() => localInput(new Date(Date.now() + 30 * 60_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(() => workspaceId && projectId
    ? `workspace_id=${encodeURIComponent(workspaceId)}&project_id=${encodeURIComponent(projectId)}`
    : null, [workspaceId, projectId]);
  const selectedList = lists.find((item) => item.id === selectedListId) ?? null;
  const selectedTodo = todos.find((item) => item.id === selectedTodoId) ?? null;

  const loadLists = useCallback(async () => {
    if (!scope) return;
    const data = await api<TodoList[]>(`/api/v1/todo-lists?${scope}`);
    setLists(data);
    setSelectedListId((current) => current && data.some((item) => item.id === current)
      ? current
      : data[0]?.id ?? null);
  }, [scope]);

  const loadTodos = useCallback(async () => {
    if (!scope || !selectedListId) {
      setTodos([]);
      setSelectedTodoId(null);
      return;
    }
    const data = await api<Todo[]>(`/api/v1/todos?${scope}&list_id=${encodeURIComponent(selectedListId)}`);
    setTodos(data);
    setSelectedTodoId((current) => current && data.some((item) => item.id === current)
      ? current
      : data[0]?.id ?? null);
  }, [scope, selectedListId]);

  const loadCalendar = useCallback(async () => {
    if (!scope || !workspaceId || !projectId) return;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 35);
    const [calendarData, itemData, reminderData] = await Promise.all([
      api<Calendar[]>(`/api/v1/calendars?${scope}`),
      api<CalendarItem[]>("/api/v1/calendar-view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          project_id: projectId,
          from: start.toISOString(),
          to: end.toISOString(),
          include_todos: true,
          include_issues: true,
        }),
      }),
      api<Reminder[]>(`/api/v1/reminders?${scope}`),
    ]);
    setCalendars(calendarData);
    setCalendarItems(itemData);
    setReminders(reminderData);
  }, [scope, workspaceId, projectId]);

  const loadWorkspace = useCallback(async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      await Promise.all([loadLists(), loadCalendar()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load scheduling workspace");
    } finally {
      setBusy(false);
    }
  }, [scope, loadLists, loadCalendar]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => { void loadTodos(); }, [loadTodos]);

  async function createList(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !newListName.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await api<{ list: TodoList }>("/api/v1/todo-lists", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("todo-list") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId,
          name: newListName, visibility: newListVisibility }),
      });
      setNewListName(""); setSelectedListId(result.list.id); await loadLists();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create list"); }
    finally { setBusy(false); }
  }

  async function createTodo(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !selectedListId || !newTodoTitle.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await api<{ todo: Todo }>("/api/v1/todos", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("todo") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId, list_id: selectedListId,
          title: newTodoTitle, body: document(newTodoBody), due_at: iso(newTodoDue),
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      setNewTodoTitle(""); setNewTodoBody(""); setNewTodoDue("");
      setSelectedTodoId(result.todo.id); await Promise.all([loadTodos(), loadCalendar()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create to-do"); }
    finally { setBusy(false); }
  }

  async function changeTodo(todo: Todo, action: "complete" | "reopen") {
    if (!workspaceId || !projectId) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/todos/${todo.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key(action) },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId,
          expected_revision: todo.revision, action }),
      });
      await Promise.all([loadTodos(), loadCalendar()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update to-do"); }
    finally { setBusy(false); }
  }

  async function createCalendar(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !newCalendarName.trim()) return;
    setBusy(true); setError(null);
    try {
      await api("/api/v1/calendars", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("calendar") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId,
          name: newCalendarName, visibility: "private",
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      setNewCalendarName(""); await loadCalendar();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create calendar"); }
    finally { setBusy(false); }
  }

  async function createEntry(event: React.FormEvent) {
    event.preventDefault();
    const calendar = calendars[0];
    if (!workspaceId || !projectId || !calendar || !entryTitle.trim()) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/calendars/${calendar.id}/entries`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("entry") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId,
          title: entryTitle, starts_at: new Date(entryStart).toISOString(),
          ends_at: new Date(entryEnd).toISOString(), source_kind: "manual",
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      setEntryTitle(""); await loadCalendar();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create calendar entry"); }
    finally { setBusy(false); }
  }

  async function createReminder(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !projectId || !selectedTodo || !reminderRecipient.trim()) return;
    setBusy(true); setError(null);
    try {
      await api("/api/v1/reminders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key("reminder") },
        body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId,
          todo_id: selectedTodo.id, recipient_principal_id: reminderRecipient.trim(),
          remind_at: new Date(reminderAt).toISOString(), delivery_channel: "in_app",
          deduplication_key: `todo:${selectedTodo.id}:${new Date(reminderAt).toISOString()}` }),
      });
      await loadCalendar();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create reminder"); }
    finally { setBusy(false); }
  }

  if (!workspaceId || !projectId) {
    return <main className={styles.setup}>
      <span className={styles.eyebrow}>Phase 4 scheduling</span>
      <h1>Open a project schedule</h1>
      <p>Use a workspace and project UUID to access private/shared lists, reminders, calendars, recurrence, and mixed planning.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        window.location.href = `/schedule?workspace_id=${encodeURIComponent(String(form.get("workspace")))}&project_id=${encodeURIComponent(String(form.get("project")))}`;
      }}>
        <input name="workspace" placeholder="Workspace UUID" required />
        <input name="project" placeholder="Project UUID" required />
        <button type="submit">Open schedule</button>
      </form>
    </main>;
  }

  return <main className={styles.workspace}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>Project schedule</span><h1>Plan work and time</h1></div>
      <div className={styles.headerActions}>
        <div className={styles.modeSwitch}>
          <button className={mode === "todos" ? styles.active : ""} onClick={() => setMode("todos")}><ListTodo size={16} /> To-dos</button>
          <button className={mode === "calendar" ? styles.active : ""} onClick={() => setMode("calendar")}><CalendarDays size={16} /> Calendar</button>
        </div>
        <button className={styles.refresh} onClick={() => void loadWorkspace()} disabled={busy}><RefreshCw size={16} /> Refresh</button>
      </div>
    </header>
    {error && <div className={styles.error}>{error}</div>}

    {mode === "todos" ? <div className={styles.todoLayout}>
      <aside className={styles.sidebarPanel}>
        <div className={styles.panelHeading}><span>Lists</span><small>{lists.length}</small></div>
        <div className={styles.listStack}>
          {lists.map((list) => <button key={list.id} onClick={() => setSelectedListId(list.id)}
            className={list.id === selectedListId ? styles.selectedList : ""}>
            {list.visibility === "private" ? <Circle size={13} /> : <Share2 size={13} />}
            <span>{list.name}</span><em>{list.visibility}</em>
          </button>)}
          {!lists.length && <p className={styles.empty}>Create your first list.</p>}
        </div>
        <form className={styles.miniForm} onSubmit={createList}>
          <strong><Plus size={15} /> New list</strong>
          <input value={newListName} onChange={(event) => setNewListName(event.target.value)} placeholder="List name" />
          <select value={newListVisibility} onChange={(event) => setNewListVisibility(event.target.value as "private" | "project")}>
            <option value="private">Private</option><option value="project">Project shared</option>
          </select>
          <button disabled={busy || !newListName.trim()}>Create list</button>
        </form>
      </aside>

      <section className={styles.todoPanel}>
        <div className={styles.panelHeading}><span>{selectedList?.name ?? "To-dos"}</span><small>{todos.length} items</small></div>
        <div className={styles.todoStack}>
          {todos.map((todo) => <button key={todo.id} className={`${styles.todoRow} ${todo.id === selectedTodoId ? styles.selectedTodo : ""}`}
            onClick={() => setSelectedTodoId(todo.id)}>
            <span className={styles.checkButton} onClick={(event) => { event.stopPropagation(); void changeTodo(todo, todo.status === "completed" ? "reopen" : "complete"); }}>
              {todo.status === "completed" ? <Check size={15} /> : <Circle size={15} />}
            </span>
            <span><strong className={todo.status === "completed" ? styles.done : ""}>{todo.title}</strong>
              <small>{todo.assignee ? `${todo.assignee.display_name} · ` : ""}{formatWhen(todo.due_at)}</small></span>
            <ChevronRight size={15} />
          </button>)}
          {!todos.length && <p className={styles.empty}>No active to-dos in this list.</p>}
        </div>
        {selectedListId && <form className={styles.createTodo} onSubmit={createTodo}>
          <input value={newTodoTitle} onChange={(event) => setNewTodoTitle(event.target.value)} placeholder="What needs to happen?" />
          <textarea value={newTodoBody} onChange={(event) => setNewTodoBody(event.target.value)} placeholder="Notes or context" rows={3} />
          <div><label>Due <input type="datetime-local" value={newTodoDue} onChange={(event) => setNewTodoDue(event.target.value)} /></label>
            <button disabled={busy || !newTodoTitle.trim()}><Plus size={15} /> Add to-do</button></div>
        </form>}
      </section>

      <aside className={styles.detailPanel}>
        {selectedTodo ? <>
          <span className={styles.statusPill}>{selectedTodo.status}</span>
          <h2>{selectedTodo.title}</h2>
          <p>{selectedTodo.plain_text || "No notes added."}</p>
          <dl><div><dt><Clock3 size={14} /> Due</dt><dd>{formatWhen(selectedTodo.due_at)}</dd></div>
            <div><dt><Repeat2 size={14} /> Recurrence</dt><dd>Rule API ready</dd></div>
            <div><dt><Sparkles size={14} /> Assignee</dt><dd>{selectedTodo.assignee?.display_name ?? "Unassigned"}</dd></div></dl>
          <form className={styles.reminderForm} onSubmit={createReminder}>
            <strong><Bell size={15} /> Add reminder</strong>
            <input value={reminderRecipient} onChange={(event) => setReminderRecipient(event.target.value)} placeholder="Recipient principal UUID" />
            <input type="datetime-local" value={reminderAt} onChange={(event) => setReminderAt(event.target.value)} />
            <button disabled={busy || !reminderRecipient.trim()}>Schedule reminder</button>
          </form>
          <div className={styles.reminderList}>{reminders.filter((item) => item.todo_id === selectedTodo.id).map((item) => <div key={item.id}>
            <Bell size={13} /><span>{formatWhen(item.remind_at)}</span><em>{item.state}</em></div>)}</div>
        </> : <p className={styles.empty}>Select a to-do to see details.</p>}
      </aside>
    </div> : <div className={styles.calendarLayout}>
      <section className={styles.calendarMain}>
        <div className={styles.panelHeading}><span>Mixed calendar</span><small>{calendarItems.length} visible items</small></div>
        <div className={styles.timeline}>
          {calendarItems.map((item) => <article key={item.id}>
            <time>{formatWhen(item.starts_at)}</time><span className={styles.source}>{item.source.replaceAll("_", " ")}</span>
            <div><strong>{item.title}</strong><small>{item.all_day ? "All day" : `${formatWhen(item.starts_at)} – ${formatWhen(item.ends_at)}`}</small></div>
          </article>)}
          {!calendarItems.length && <p className={styles.empty}>No visible scheduled work in this window.</p>}
        </div>
      </section>
      <aside className={styles.calendarTools}>
        <div className={styles.foundationCard}><Radio size={17} /><div><strong>Realtime foundation</strong><span>Cursor events and presence are permission filtered.</span></div></div>
        <form className={styles.miniForm} onSubmit={createCalendar}>
          <strong><CalendarDays size={15} /> New calendar</strong>
          <input value={newCalendarName} onChange={(event) => setNewCalendarName(event.target.value)} placeholder="Calendar name" />
          <button disabled={busy || !newCalendarName.trim()}>Create calendar</button>
        </form>
        <form className={styles.miniForm} onSubmit={createEntry}>
          <strong><Plus size={15} /> New event</strong>
          {!calendars.length && <small>Create a calendar first.</small>}
          <input value={entryTitle} onChange={(event) => setEntryTitle(event.target.value)} placeholder="Event title" />
          <label>Starts <input type="datetime-local" value={entryStart} onChange={(event) => setEntryStart(event.target.value)} /></label>
          <label>Ends <input type="datetime-local" value={entryEnd} onChange={(event) => setEntryEnd(event.target.value)} /></label>
          <button disabled={busy || !calendars.length || !entryTitle.trim()}>Add event</button>
        </form>
        <div className={styles.integrationCard}><Sparkles size={17} /><div><strong>Provider adapters</strong><span>Discovery and pull contracts are ready; two-way sync remains decision-gated.</span></div></div>
      </aside>
    </div>}
  </main>;
}
