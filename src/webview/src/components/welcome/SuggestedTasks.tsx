import { NewTaskRequest } from "@shared/proto/cline/task"
import React from "react"
import { useI18n } from "@/i18n"
import { TaskServiceClient } from "@/services/grpcClient"
import QuickWinCard from "./QuickWinCard"
import { QuickWinTask, quickWinTasks } from "./quickWinTasks"

export const SuggestedTasks: React.FC<{ shouldShowQuickWins: boolean }> = ({ shouldShowQuickWins }) => {
	const { t } = useI18n()
	const handleExecuteQuickWin = async (prompt: string) => {
		await TaskServiceClient.newTask(NewTaskRequest.create({ text: prompt, images: [] }))
	}

	if (shouldShowQuickWins) {
		return (
			<div className="px-4 pt-1 pb-3 select-none">
				{" "}
				<h2 className="text-sm font-medium mb-2.5 text-center text-gray">
					{t("home.quickWins")}
				</h2>
				<div className="flex flex-col space-y-1">
					{" "}
					{quickWinTasks.map((task: QuickWinTask) => (
						<QuickWinCard key={task.id} onExecute={() => handleExecuteQuickWin(task.prompt)} task={task} />
					))}
				</div>
			</div>
		)
	}
}
