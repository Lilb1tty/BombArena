-- Stores the registered Account identity and its Argon2id Password Credential.
-- The case-insensitive collation is intentional: it makes the unique index
-- enforce Pixel Arena's case-insensitive username rule at the database layer.
CREATE TABLE `Account` (
    `id` VARCHAR(30) NOT NULL,
    `username` VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
    `passwordCredentialHash` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Account_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
