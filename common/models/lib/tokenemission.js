/**
 *
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */
/**
 * @description   Fetch Next FlowObjects
 * @author Kangan Verma(kangan06), Mandeep Gill(mandeep6ill), Prem Sai(premsai-ch), Vivek Mittal(vivekmittal07)
 */

var logger = require('oe-logger');
var log = logger('TokenEmission');
var sequenceFlowEvaluator = require('./workflow-nodes/evaluate-sequence-flow.js');

exports.getNextFlowObjects = function getNextFlowObjects(currentFlowObject, message, processDefinitionInstance, process, options) {
  var nextFlowObjects = [];
  var outgoingSequenceFlows = getOutgoingSequenceFlows(currentFlowObject, processDefinitionInstance);
  var singleOutFlow = outgoingSequenceFlows.length === 1;

  var pushAll = function pushAll(flowObject, attachedSeqFlow) {
    if (typeof attachedSeqFlow !== 'undefined') {
      flowObject.attachedSeqFlow = attachedSeqFlow;
    }
    if (flowObject.isParallelGateway) {
      var expectedObjects = getIncomingSequenceFlows(flowObject, processDefinitionInstance);
      flowObject.expectedInFlows = expectedObjects.map(function mapFlowObjects(flow) { return flow.bpmnId; });
    }
    nextFlowObjects.push(flowObject);
  };

  var i;
  var flow;
  if (currentFlowObject.isExclusiveGateway && singleOutFlow) {
    pushAll(processDefinitionInstance.getProcessElement(outgoingSequenceFlows[0].targetRef), outgoingSequenceFlows[0].bpmnId);
  } else if (currentFlowObject.isExclusiveGateway && !singleOutFlow) {
    var branchFlag = false;
    var defaultFlow = currentFlowObject.default;
    for (i in outgoingSequenceFlows) {
      if (Object.prototype.hasOwnProperty.call(outgoingSequenceFlows, i)) {
        flow = outgoingSequenceFlows[i];
        if (flow.bpmnId !== defaultFlow && sequenceFlowEvaluator.evaluate(options, flow, message, process)) {
          pushAll(processDefinitionInstance.getProcessElement(outgoingSequenceFlows[i].targetRef), outgoingSequenceFlows[i].bpmnId);
          branchFlag = true;
          break;
        }
      }
    }
    if (branchFlag === false) {
      if (defaultFlow) {
        var defaultFlowObj = outgoingSequenceFlows.filter(function getDefaultFlow(flow) { return (flow.bpmnId === defaultFlow);})[0];
        pushAll(processDefinitionInstance.getProcessElement(defaultFlowObj.targetRef), defaultFlowObj.bpmnId);
      } else {
        log.error(options, 'No branch confirms to the logic in {Exclusive Gateway - Diverging} and no default defined');
      }
    }
  } else if (currentFlowObject.isParallelGateway) {
    for (i in outgoingSequenceFlows) {
      if (Object.prototype.hasOwnProperty.call(outgoingSequenceFlows, i)) {
        flow = outgoingSequenceFlows[i];
        pushAll(processDefinitionInstance.getProcessElement(flow.targetRef), flow.bpmnId);
      }
    }
  } else if (currentFlowObject.isEventGateway) {
    for (i in outgoingSequenceFlows) {
      if (Object.prototype.hasOwnProperty.call(outgoingSequenceFlows, i)) {
        flow = outgoingSequenceFlows[i];
        pushAll(processDefinitionInstance.getProcessElement(flow.targetRef), flow.bpmnId);
      }
    }
    var flowObjNames = nextFlowObjects.map(function mapFlowObjects(flowObject) { return flowObject.name; });
    for (i in nextFlowObjects) {
      if (Object.prototype.hasOwnProperty.call(nextFlowObjects, i)) {
        nextFlowObjects[i].attachedFlowObjects = flowObjNames.slice();
        var idx = flowObjNames.indexOf(nextFlowObjects[i].name);
        if (idx > -1) {
          nextFlowObjects[i].attachedFlowObjects.splice(idx, 1);
        }
        nextFlowObjects[i].isAttachedToEventGateway = true;
      }
    }
  } else if (currentFlowObject.isInclusiveGateway) {
    branchFlag = false;
    for (i in outgoingSequenceFlows) {
      if (Object.prototype.hasOwnProperty.call(outgoingSequenceFlows, i)) {
        flow = outgoingSequenceFlows[i];
        if (sequenceFlowEvaluator.evaluate(options, flow, message, process)) {
          pushAll(processDefinitionInstance.getProcessElement(flow.targetRef), flow.bpmnId);
          branchFlag = true;
        }
      }
    }
    if (!branchFlag) {
      log.error(options, 'No branch confirms to the logic in {Inclusive Gateway - Diverging} and no default defined');
    }
  } else {
    for (i in outgoingSequenceFlows) {
      if (Object.prototype.hasOwnProperty.call(outgoingSequenceFlows, i)) {
        flow = outgoingSequenceFlows[i];
        pushAll(processDefinitionInstance.getProcessElement(flow.targetRef), flow.bpmnId);
      }
    }
  }

  var boundaryFlowObjects = [];
  for (var k = 0; k < nextFlowObjects.length; k++) {
    var flowObject = nextFlowObjects[k];
    var boundaryEvents = processDefinitionInstance.processDefinition.boundaryEventsByAttachmentIndex[flowObject.bpmnId] || [];
    boundaryFlowObjects = boundaryFlowObjects.concat(boundaryEvents);
  }

  // console.log('emitting token for boundary events : ', JSON.stringify(boundaryFlowObjects));
  return nextFlowObjects.concat(boundaryFlowObjects);
};

//  Function used to get all the outgoing sequenceFlows from a given flowObject
var getOutgoingSequenceFlows = function getOutgoingSequenceFlows(flowObject, processDefinition) {
  return processDefinition._getFlows('sequenceFlowBySourceIndex', flowObject);
};

var getIncomingSequenceFlows = function getIncomingSequenceFlows(flowObject, processDefinition) {
  return processDefinition._getFlows('sequenceFlowBySourceTarget', flowObject);
};
