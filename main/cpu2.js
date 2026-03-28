// ─────────────────────────────────────────────
// cpu2.js
// CPU for TETLABO versus mode - Basic Flow Implementation
// ─────────────────────────────────────────────

class CPU2 {
    constructor(gameInstance) {
        this.game = gameInstance;
        this.isActive = false;
        this.currentMino = null;
        this.fieldTerrain = [];
        this.bestPlacement = null;
        this.commandQueue = [];
        this.isProcessing = false;
    }

    // Step 1: Start CPU and retrieve current game state
    start() {
        this.isActive = true;
        this.updateLoop();
    }

    stop() {
        this.isActive = false;
        this.commandQueue = [];
        this.isProcessing = false;
    }

    updateLoop() {
        if (!this.isActive) return;

        // Check if new mino spawned
        if (this.game.mino && this.game.mino !== this.currentMino) {
            this.currentMino = this.game.mino;
            this.onNewMino();
        }

        // Process command queue
        if (!this.isProcessing && this.commandQueue.length > 0) {
            this.executeNextCommand();
        }

        requestAnimationFrame(() => this.updateLoop());
    }

    // Step 1: Retrieve current controllable Minos and field terrain
    onNewMino() {
        // Get current mino information
        const minoInfo = this.getCurrentMinoInfo();

        // Get field terrain as array
        this.fieldTerrain = this.getFieldTerrain();

        // Step 2: Search for best placement
        this.bestPlacement = this.searchBestPlacement(minoInfo, this.fieldTerrain);

        // Step 3: Convert placement to control commands
        if (this.bestPlacement) {
            this.commandQueue = this.generateCommands(this.bestPlacement);
        }
    }

    getCurrentMinoInfo() {
        if (!this.game.mino) return null;

        return {
            type: this.game.mino.type,
            x: this.game.mino.x,
            y: this.game.mino.y,
            rotation: this.game.mino.rotation,
            blocks: this.game.mino.blocks.map(b => ({x: b.x, y: b.y}))
        };
    }

    getFieldTerrain() {
        // Convert field blocks to 2D array representation
        const terrain = Array(20).fill(null).map(() => Array(10).fill(0));

        this.game.field.blocks.forEach(block => {
            if (block.y >= 0 && block.y < 20 && block.x >= 0 && block.x < 10) {
                terrain[block.y][block.x] = 1;
            }
        });

        return terrain;
    }

    // Step 2: Search for placement location (simplified version)
    searchBestPlacement(minoInfo, terrain) {
        let bestScore = -Infinity;
        let bestPlacement = null;

        // Try all rotations and positions
        for (let rotation = 0; rotation < 4; rotation++) {
            for (let x = 0; x < 10; x++) {
                const placement = this.testPlacement(minoInfo, rotation, x, terrain);

                if (placement.isValid) {
                    const score = this.evaluatePlacement(placement, terrain);

                    if (score > bestScore) {
                        bestScore = score;
                        bestPlacement = placement;
                    }
                }
            }
        }

        return bestPlacement;
    }

    testPlacement(minoInfo, targetRotation, targetX, terrain) {
        // Create test mino with target rotation
        const testMino = new Mino(minoInfo.type);
        for (let i = 0; i < targetRotation; i++) {
            testMino.rotate();
        }

        // Find lowest valid Y position
        let testY = 0;
        while (this.isValidPosition(testMino, targetX, testY, terrain)) {
            testY++;
        }
        testY--; // Go back to last valid position

        // Check if placement is valid
        if (!this.isValidPosition(testMino, targetX, testY, terrain)) {
            return { isValid: false };
        }

        return {
            isValid: true,
            rotation: targetRotation,
            x: targetX,
            y: testY,
            mino: testMino
        };
    }

    isValidPosition(mino, x, y, terrain) {
        return mino.blocks.every(block => {
            const blockX = block.x + x;
            const blockY = block.y + y;

            // Check boundaries
            if (blockX < 0 || blockX >= 10 || blockY >= 20) {
                return false;
            }

            // Check collision with terrain (ignore above y=0 for ceiling)
            if (blockY >= 0 && terrain[blockY][blockX]) {
                return false;
            }

            return true;
        });
    }

    evaluatePlacement(placement, terrain) {
        // Simple evaluation: lower height = better
        const heightPenalty = placement.y * 10;

        // Count lines that would be cleared
        const linesCleared = this.simulateLineClear(placement, terrain);
        const lineBonus = linesCleared * 100;

        return lineBonus - heightPenalty;
    }

    simulateLineClear(placement, terrain) {
        // Copy terrain and add placed blocks
        const testTerrain = terrain.map(row => [...row]);

        placement.mino.blocks.forEach(block => {
            const x = block.x + placement.x;
            const y = block.y + placement.y;
            if (y >= 0 && y < 20 && x >= 0 && x < 10) {
                testTerrain[y][x] = 1;
            }
        });

        // Count full lines
        let linesCleared = 0;
        for (let y = 0; y < 20; y++) {
            if (testTerrain[y].every(cell => cell === 1)) {
                linesCleared++;
            }
        }

        return linesCleared;
    }

    // Step 3: Convert placement location to control commands
    generateCommands(placement) {
        const commands = [];
        const currentMino = this.getCurrentMinoInfo();

        if (!currentMino) return commands;

        // Rotation commands
        while (currentMino.rotation !== placement.rotation) {
            commands.push({ type: 'rotate', direction: 1 }); // CW rotation
            currentMino.rotation = (currentMino.rotation + 1) % 4;
        }

        // Movement commands
        const dx = placement.x - currentMino.x;
        if (dx > 0) {
            for (let i = 0; i < dx; i++) {
                commands.push({ type: 'move', direction: 1 }); // Right
            }
        } else if (dx < 0) {
            for (let i = 0; i < Math.abs(dx); i++) {
                commands.push({ type: 'move', direction: -1 }); // Left
            }
        }

        // Final hard drop
        commands.push({ type: 'hardDrop' });

        return commands;
    }

    // Step 4: Execute control commands
    async executeNextCommand() {
        if (this.commandQueue.length === 0 || this.isProcessing) return;

        this.isProcessing = true;
        const command = this.commandQueue.shift();

        try {
            switch (command.type) {
                case 'move':
                    await this.executeMove(command.direction);
                    break;
                case 'rotate':
                    await this.executeRotate(command.direction);
                    break;
                case 'hardDrop':
                    await this.executeHardDrop();
                    break;
            }
        } catch (error) {
            console.error('CPU command execution error:', error);
        }

        // Delay between commands
        setTimeout(() => {
            this.isProcessing = false;
        }, 50); // 50ms delay between commands
    }

    async executeMove(direction) {
        return new Promise(resolve => {
            if (direction > 0) {
                this.game.moveMino(1, 0);
            } else {
                this.game.moveMino(-1, 0);
            }
            this.game.drawAll();
            resolve();
        });
    }

    async executeRotate(direction) {
        return new Promise(resolve => {
            if (direction > 0) {
                this.game.tryRotate(1); // CW
            } else {
                this.game.tryRotate(-1); // CCW
            }
            this.game.drawAll();
            resolve();
        });
    }

    async executeHardDrop() {
        return new Promise(resolve => {
            this.game.hardDrop();
            resolve();
        });
    }
}
