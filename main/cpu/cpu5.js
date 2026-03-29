// Expert CPU with advanced algorithms
class CPU5 extends CPU4 {
    constructor(gameInstance) {
        super(gameInstance);
        this.lookaheadDepth = 2; // Look at next 2 pieces
        this.weights = {
            lineClear: 150,
            tSpin: 300,
            perfectClear: 500,
            height: -20,
            holes: -40,
            bumpiness: -25,
            well: -10
        };
    }

    evaluatePlacement(placement, terrain) {
        let score = super.evaluatePlacement(placement, terrain);

        // Perfect clear detection
        if (this.isPerfectClear(placement, terrain)) {
            score += this.weights.perfectClear;
        }

        // Well depth analysis
        score += this.analyzeWells(placement, terrain) * this.weights.well;

        return score;
    }

    isPerfectClear(placement, terrain) {
        const newTerrain = this.simulatePlacement(placement, terrain);

        // Check if any lines remain after placement
        for (let y = 0; y < 20; y++) {
            if (newTerrain[y].some(cell => cell === 1)) {
                return false;
            }
        }
        return true;
    }

    analyzeWells(placement, terrain) {
        const newTerrain = this.simulatePlacement(placement, terrain);
        const heights = Array(10).fill(20);

        // Calculate column heights
        for (let x = 0; x < 10; x++) {
            for (let y = 0; y < 20; y++) {
                if (newTerrain[y][x] === 1) {
                    heights[x] = y;
                    break;
                }
            }
        }

        // Find wells (deep columns)
        let wellPenalty = 0;
        for (let x = 0; x < 10; x++) {
            const leftHeight = x > 0 ? heights[x - 1] : 20;
            const rightHeight = x < 9 ? heights[x + 1] : 20;
            const currentHeight = heights[x];

            if (currentHeight > leftHeight + 2 && currentHeight > rightHeight + 2) {
                // Deep well
                const wellDepth = Math.min(currentHeight - leftHeight, currentHeight - rightHeight);
                wellPenalty += wellDepth * wellDepth; // Quadratic penalty
            }
        }

        return wellPenalty;
    }
}
