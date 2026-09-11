// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RefutationMarket} from "../src/RefutationMarket.sol";

contract Deploy is Script {
    function run() external {
        address arbiter = vm.envAddress("ARBITER_ADDRESS");
        uint64 revealWindow = uint64(vm.envOr("REVEAL_WINDOW", uint256(90)));
        uint64 adjudicationWindow = uint64(vm.envOr("ADJUDICATION_WINDOW", uint256(90)));
        uint64 disclosureWindow = uint64(vm.envOr("DISCLOSURE_WINDOW", uint256(90)));
        uint64 arbitrationWindow = uint64(vm.envOr("ARBITRATION_WINDOW", uint256(90)));
        uint256 bondBps = vm.envOr("BOND_BPS", uint256(2000));
        vm.startBroadcast();
        RefutationMarket m = new RefutationMarket(arbiter, revealWindow, adjudicationWindow, disclosureWindow, arbitrationWindow, bondBps);
        vm.stopBroadcast();
        console.log("MARKET_ADDRESS=%s", address(m));
    }
}
