import { Suspense } from "react";

import { TasksScreen } from "@/features/tasks/tasks-screen";

/**
 * /tasks — the task centre (Daily Tasks, milestone B). Behind the daily_tasks flag: every /api/tasks route
 * answers 404 while it is OFF, and the navigation does not list the screen.
 */
export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksScreen />
    </Suspense>
  );
}
