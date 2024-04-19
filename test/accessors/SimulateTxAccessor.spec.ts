import { expect } from "chai";
import hre, { deployments, ethers } from "hardhat";
import { deployContract, getSimulateTxAccessor, getSafeWithOwners, getCompatFallbackHandler, getWallets } from "../utils/setup";
import { buildContractCall } from "../../src/utils/execution";

describe("SimulateTxAccessor", () => {
    const setupTests = deployments.createFixture(async ({ deployments }) => {
        await deployments.fixture();
        const signers = await getWallets();
        const [user1] = signers;
        const accessor = await getSimulateTxAccessor();
        const source = `
        contract Test {
            function sendAndReturnBalance(address payable target, uint256 amount) public returns (uint256) {
                (bool success,) = target.call{ value: amount }("");
                require(success, "Transfer failed");
                return target.balance;
            }
        }`;
        const interactor = await deployContract(user1, source);
        const handler = await getCompatFallbackHandler();
        const handlerAddress = await handler.getAddress();
        const safe = await getSafeWithOwners([user1.address], 1, handlerAddress);
        const safeAddress = await safe.getAddress();
        const simulator = await getCompatFallbackHandler(safeAddress);
        return {
            safe,
            accessor,
            interactor,
            simulator,
            signers,
        };
    });

    describe("estimate", () => {
        it("should enforce delegatecall", async () => {
            const { accessor, signers, interactor } = await setupTests();
            const [user1] = signers;
            const tx = await buildContractCall(interactor, "sendAndReturnBalance", [user1.address, 0], 0);
            const accessorAddress = accessor.getAddress();

            const code = await hre.ethers.provider.getCode(accessorAddress);
            await expect(accessor.simulate(tx.to, tx.value, tx.data, tx.operation)).to.be.revertedWith(
                "SimulateTxAccessor should only be called via delegatecall",
            );

            expect(await hre.ethers.provider.getCode(accessorAddress)).to.be.eq(code);
        });

        it("simulate call", async () => {
            const { safe, accessor, simulator, signers } = await setupTests();
            const [user1] = signers;
            const accessorAddress = await accessor.getAddress();
            const tx = await buildContractCall(safe, "getOwners", [], 0);
            const simulationData = accessor.interface.encodeFunctionData("simulate", [tx.to, tx.value, tx.data, tx.operation]);
            const acccessibleData = await simulator.simulate.staticCall(accessorAddress, simulationData);
            const simulation = accessor.interface.decodeFunctionResult("simulate", acccessibleData);
            expect(safe.interface.decodeFunctionResult("getOwners", simulation.returnData)[0]).to.be.deep.eq([user1.address]);
            expect(simulation.success).to.be.true;
            expect(simulation.estimate).to.be.lte(10000n);
        });

        it("simulate delegatecall", async () => {
            const { safe, accessor, interactor, simulator, signers } = await setupTests();
            const [user1, user2] = signers;
            const accessorAddress = await accessor.getAddress();
            const safeAddress = await safe.getAddress();
            await (await user1.sendTransaction({ to: safeAddress, value: ethers.parseEther("1") })).wait();
            const userBalance = await hre.ethers.provider.getBalance(user2.address);
            const tx = await buildContractCall(interactor, "sendAndReturnBalance", [user2.address, ethers.parseEther("1")], 0, true);
            const simulationData = accessor.interface.encodeFunctionData("simulate", [tx.to, tx.value, tx.data, tx.operation]);
            const acccessibleData = await simulator.simulate.staticCall(accessorAddress, simulationData);
            const simulation = accessor.interface.decodeFunctionResult("simulate", acccessibleData);
            expect(interactor.interface.decodeFunctionResult("sendAndReturnBalance", simulation.returnData)[0]).to.be.deep.eq(
                userBalance + ethers.parseEther("1"),
            );
            expect(simulation.success).to.be.true;
            expect(simulation.estimate.toNumber()).to.be.lte(hre.network.zksync ? 30000n : 15000n);
        });

        it("simulate revert", async () => {
            const { accessor, interactor, simulator, signers } = await setupTests();
            const [, user2] = await signers;
            const accessorAddress = await accessor.getAddress();
            const tx = await buildContractCall(interactor, "sendAndReturnBalance", [user2.address, ethers.parseEther("1")], 0, true);
            const simulationData = accessor.interface.encodeFunctionData("simulate", [tx.to, tx.value, tx.data, tx.operation]);
            const acccessibleData = await simulator.simulate.staticCall(accessorAddress, simulationData);
            const simulation = accessor.interface.decodeFunctionResult("simulate", acccessibleData);
            expect(simulation.returnData).to.be.deep.eq(
                "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f5472616e73666572206661696c65640000000000000000000000000000000000",
            );
            expect(simulation.success).to.be.false;
            expect(simulation.estimate).to.be.lte(20000n);
        });
    });
});
