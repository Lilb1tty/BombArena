-- Persists final and aborted Game outcomes independently from the live Room.
CREATE TABLE `GameResult` (
    `id` VARCHAR(30) NOT NULL,
    `status` ENUM('COMPLETED', 'ABORTED') NOT NULL,
    `roomCode` VARCHAR(6) NOT NULL,
    `gameSeed` INTEGER UNSIGNED NOT NULL,
    `mapVersion` VARCHAR(32) NOT NULL,
    `durationMs` INTEGER UNSIGNED NOT NULL,
    `outcomeKind` ENUM('WINNER', 'DRAW') NULL,
    `endReason` ENUM('ELIMINATION', 'TIMEOUT', 'ABORTED') NOT NULL,
    `endedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    INDEX `GameResult_status_endedAt_idx`(`status`, `endedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE `GameResultParticipant` (
    `gameResultId` VARCHAR(30) NOT NULL,
    `accountId` VARCHAR(30) NOT NULL,
    `outcome` ENUM('WON', 'LOST', 'DRAW', 'ABORTED') NOT NULL,
    `kills` INTEGER UNSIGNED NOT NULL DEFAULT 0,

    PRIMARY KEY (`gameResultId`, `accountId`),
    INDEX `GameResultParticipant_accountId_gameResultId_idx`(`accountId`, `gameResultId`),
    CONSTRAINT `GameResultParticipant_gameResultId_fkey`
      FOREIGN KEY (`gameResultId`) REFERENCES `GameResult`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `GameResultParticipant_accountId_fkey`
      FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
