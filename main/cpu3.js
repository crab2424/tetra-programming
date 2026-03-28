// Enhanced version of cpu2.js with better evaluation
class CPU3 extends CPU2 {
    constructor(gameInstance) {
        super(gameInstance);
        // Add medium-level evaluation weights
        this.weights = {
            lineClear: 50,
            height: -10,
            holes: -20,
            bumpiness: -15
        };
    }

    evaluatePlacement(placement, terrain) {
        // More sophisticated evaluation than CPU2
        let score = 0;

        // Line clear bonus
        const linesCleared = this.simulateLineClear(placement, terrain);
        score += linesCleared * this.weights.lineClear;

        // Height penalty
        score += placement.y * this.weights.height;

        // Hole penalty
        score += this.countHoles(placement, terrain) * this.weights.holes;

        // Surface bumpiness penalty
        score += this.calculateBumpiness(placement, terrain) * this.weights.bumpiness;

        return score;
    }

    countHoles(placement, terrain) {
        // Count holes after placement
        const testTerrain = terrain.map(row => [...row]);
        placement.mino.blocks.forEach(block => {
            const x = block.x + placement.x;
            const y = block.y + placement.y;
            if (y >= 0 && y < 20 && x >= 0 && x < 10) {
                testTerrain[y][x] = 1;
            }
        });

        let holes = 0;
        for (let x = 0; x < 10; x++) {
            let foundBlock = false;
            for (let y = 0; y < 20; y++) {
                if (testTerrain[y][x] === 1) {
                    foundBlock = true;
                } else if (foundBlock && testTerrain[y][x] === 0) {
                    holes++;
                }
            }
        }
        return holes;
    }

    calculateBumpiness(placement, terrain) {
        // Calculate surface unevenness
        const heights = Array(10).fill(20);
        const testTerrain = terrain.map(row => [...row]);

        placement.mino.blocks.forEach(block => {
            const x = block.x + placement.x;
            const y = block.y + placement.y;
            if (y >= 0 && y < 20 && x >= 0 && x < 10) {
                testTerrain[y][x] = 1;
            }
        });

        for (let x = 0; x < 10; x++) {
            for (let y = 0; y < 20; y++) {
                if (testTerrain[y][x] === 1) {
                    heights[x] = y;
                    break;
                }
            }
        }

        let bumpiness = 0;
        for (let x = 0; x < 9; x++) {
            bumpiness += Math.abs(heights[x] - heights[x + 1]);
        }
        return bumpiness;
    }
}
