// Advanced CPU with lookahead and T-spin detection
class CPU4 extends CPU3 {
    constructor(gameInstance) {
        super(gameInstance);
        this.lookaheadDepth = 1; // Consider next piece
        // More aggressive weights
        this.weights = {
            lineClear: 100,
            tSpin: 200,
            height: -15,
            holes: -30,
            bumpiness: -20
        };
    }

    searchBestPlacement(minoInfo, terrain) {
        // Include next piece in decision making
        const nextMino = this.game.nextQueue[0];
        if (nextMino && this.lookaheadDepth > 0) {
            return this.searchWithLookahead(minoInfo, terrain, nextMino);
        }
        return super.searchBestPlacement(minoInfo, terrain);
    }

    searchWithLookahead(currentMino, terrain, nextMino) {
        let bestScore = -Infinity;
        let bestPlacement = null;

        // Try all placements for current piece
        for (let rotation = 0; rotation < 4; rotation++) {
            for (let x = 0; x < 10; x++) {
                const placement = this.testPlacement(currentMino, rotation, x, terrain);

                if (placement.isValid) {
                    // Simulate current placement
                    const nextTerrain = this.simulatePlacement(placement, terrain);

                    // Evaluate next piece on resulting terrain
                    const nextMinoInfo = {
                        type: nextMino.type,
                        x: 3, y: 0, rotation: 0,
                        blocks: nextMino.blocks.map(b => ({x: b.x, y: b.y}))
                    };

                    const nextBest = this.searchBestPlacement(nextMinoInfo, nextTerrain);
                    const nextScore = nextBest ? this.evaluatePlacement(nextBest, nextTerrain) : 0;

                    // Combined score
                    const currentScore = this.evaluatePlacement(placement, terrain);
                    const totalScore = currentScore + (nextScore * 0.3); // Weight next piece less

                    if (totalScore > bestScore) {
                        bestScore = totalScore;
                        bestPlacement = placement;
                    }
                }
            }
        }

        return bestPlacement;
    }

    evaluatePlacement(placement, terrain) {
        let score = super.evaluatePlacement(placement, terrain);

        // T-spin detection bonus
        const tSpinBonus = this.detectTSpin(placement, terrain);
        score += tSpinBonus * this.weights.tSpin;

        return score;
    }

    detectTSpin(placement, terrain) {
        // Simple T-spin detection
        if (placement.mino.type !== 5) return 0; // Not T-piece

        // Check if T-piece is in T-spin position
        const corners = this.getTSpinCorners(placement);
        let filledCorners = 0;

        corners.forEach(corner => {
            const [x, y] = corner;
            if (x < 0 || x >= 10 || y >= 20) {
                filledCorners++; // Wall counts as filled
            } else if (y >= 0 && terrain[y][x]) {
                filledCorners++;
            }
        });

        return filledCorners >= 3 ? 1 : 0;
    }

    getTSpinCorners(placement) {
        // Get the 4 corners around T-piece center
        const centerX = placement.x + 1;
        const centerY = placement.y + 1;

        return [
            [centerX - 1, centerY - 1],
            [centerX + 1, centerY - 1],
            [centerX - 1, centerY + 1],
            [centerX + 1, centerY + 1]
        ];
    }

    simulatePlacement(placement, terrain) {
        const newTerrain = terrain.map(row => [...row]);
        placement.mino.blocks.forEach(block => {
            const x = block.x + placement.x;
            const y = block.y + placement.y;
            if (y >= 0 && y < 20 && x >= 0 && x < 10) {
                newTerrain[y][x] = 1;
            }
        });
        return newTerrain;
    }
}
