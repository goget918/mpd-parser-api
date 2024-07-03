/**
 * Node interface isn't available in console platform,
 * so will use our own constants
 * 
 * reference_node(5), entity_node(6), notation_node(12)
 * are deprecated, not in use anymore.
 */
const node_constants =  {
  element_node: 1,
  attribution_node: 2,
  text_node: 3,
  cdata_section_node: 4,
  processing_instruction_node: 7,
  comment_node: 8,
  document_node: 9,
  document_type_node: 10,
  document_fragment_node: 11
};

module.exports = node_constants;
