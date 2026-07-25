// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, List, Button, Modal, Form, Input, InputNumber, Select, Switch,
  Space, Spin, message, Row, Col, Tree, Tag, Descriptions, Popconfirm,
  Empty, Tabs, Tooltip,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  BarcodeOutlined, HomeOutlined, EnvironmentOutlined, AppstoreOutlined,
  HddOutlined, InboxOutlined, DownloadOutlined, BlockOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import BarcodeDisplay from '../../components/BarcodeDisplay';
import api from '../../config/api';
import { getErrorMessage, downloadExcel } from '../../utils/helpers';

const WAREHOUSE_TYPES = [
  { label: 'Main Warehouse', value: 'main' },
  { label: 'Distribution Center', value: 'distribution' },
  { label: 'Cold Storage', value: 'cold_storage' },
  { label: 'Transit', value: 'transit' },
  { label: 'Returns', value: 'returns' },
  { label: 'Quarantine', value: 'quarantine' },
];

const BIN_TYPES = [
  { label: 'Shelf', value: 'shelf' },
  { label: 'Pallet', value: 'pallet' },
  { label: 'Floor', value: 'floor' },
  { label: 'Bulk', value: 'bulk' },
  { label: 'Pick', value: 'pick' },
];

const LEVEL_LABELS = {
  location: { singular: 'Location', plural: 'Locations', icon: <EnvironmentOutlined /> },
  line: { singular: 'Line', plural: 'Lines', icon: <AppstoreOutlined /> },
  rack: { singular: 'Rack', plural: 'Racks', icon: <HddOutlined /> },
  bin: { singular: 'Bin', plural: 'Bins', icon: <InboxOutlined /> },
};

const Warehouses = () => {
  const navigate = useNavigate();
  const [warehouses, setWarehouses] = useState([]);
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedWarehouse, setSelectedWarehouse] = useState(null);
  const [treeData, setTreeData] = useState([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);

  // Modals
  const [nodeModalOpen, setNodeModalOpen] = useState(false);
  const [editingNode, setEditingNode] = useState(null);
  const [nodeLevel, setNodeLevel] = useState(null);
  const [nodeParentId, setNodeParentId] = useState(null);
  const [nodeForm] = Form.useForm();
  const [nodeSubmitting, setNodeSubmitting] = useState(false);

  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [barcodeValue, setBarcodeValue] = useState('');

  useEffect(() => {
    fetchWarehouses();
  }, []);

  useEffect(() => {
    if (selectedWarehouse) {
      fetchWarehouseHierarchy(selectedWarehouse.id);
    }
  }, [selectedWarehouse]);

  const fetchWarehouses = async () => {
    setLoading(true);
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setWarehouses(items);
      // BUG-FE-071: also re-pick when the previously-selected warehouse is no
      // longer in the list (deleted in another tab) — without this the panel
      // shows blank until the user manually picks again.
      if (items.length > 0) {
        if (!selectedWarehouse) {
          setSelectedWarehouse(items[0]);
        } else if (!items.find((w) => w.id === selectedWarehouse.id)) {
          setSelectedWarehouse(items[0]);
        }
      } else {
        setSelectedWarehouse(null);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchWarehouseHierarchy = async (warehouseId) => {
    // WH-1 fix: single API call replaces 81+ sequential requests
    setTreeLoading(true);
    setTreeData([]);
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/structure`);
      const locations = res.data.locations || [];

      const tree = locations.map((loc) => ({
        key: `location-${loc.id}`,
        title: loc.name || loc.code,
        icon: <EnvironmentOutlined />,
        level: 'location',
        entityId: loc.id,
        data: loc,
        children: (loc.lines || []).map((line) => ({
          key: `line-${line.id}`,
          title: line.name || line.code,
          icon: <AppstoreOutlined />,
          level: 'line',
          entityId: line.id,
          parentId: loc.id,
          data: line,
          children: (line.racks || []).map((rack) => ({
            key: `rack-${rack.id}`,
            title: rack.name || rack.code,
            icon: <HddOutlined />,
            level: 'rack',
            entityId: rack.id,
            parentId: line.id,
            data: rack,
            children: (rack.bins || []).map((bin) => ({
              key: `bin-${bin.id}`,
              title: bin.name || bin.code,
              icon: <InboxOutlined />,
              level: 'bin',
              entityId: bin.id,
              parentId: rack.id,
              data: bin,
              isLeaf: true,
            })),
          })),
        })),
      }));

      setTreeData(tree);
      if (locations.length > 0) {
        setExpandedKeys(locations.map((l) => `location-${l.id}`));
      }
    } catch {
      setTreeData([]);
    } finally {
      setTreeLoading(false);
    }
  };

  // Warehouse CRUD
  const handleAddWarehouse = () => {
    navigate('/masters/warehouses/new');
  };

  const handleEditWarehouse = (wh) => {
    navigate(`/masters/warehouses/${wh.id}/edit`);
  };

  const handleDeleteWarehouse = async (id) => {
    try {
      await api.delete(`/masters/warehouses/${id}`);
      message.success('Warehouse deleted');
      if (selectedWarehouse?.id === id) {
        setSelectedWarehouse(null);
        setTreeData([]);
      }
      fetchWarehouses();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Hierarchy node CRUD
  const getApiUrl = (level, parentId) => {
    const whId = selectedWarehouse.id;
    if (level === 'location') return `/masters/warehouses/${whId}/locations`;
    if (level === 'line') return `/masters/warehouses/${whId}/locations/${parentId}/lines`;
    if (level === 'rack') return `/masters/warehouses/${whId}/lines/${parentId}/racks`;
    if (level === 'bin') return `/masters/warehouses/${whId}/racks/${parentId}/bins`;
    return '';
  };

  const getUpdateUrl = (level, entityId) => {
    const whId = selectedWarehouse.id;
    if (level === 'location') return `/masters/warehouses/${whId}/locations/${entityId}`;
    if (level === 'line') return `/masters/warehouses/${whId}/lines/${entityId}`;
    if (level === 'rack') return `/masters/warehouses/${whId}/racks/${entityId}`;
    if (level === 'bin') return `/masters/warehouses/${whId}/bins/${entityId}`;
    return '';
  };

  const handleAddNode = (level, parentId) => {
    setEditingNode(null);
    setNodeLevel(level);
    setNodeParentId(parentId);
    nodeForm.resetFields();
    if (level === 'bin') {
      nodeForm.setFieldsValue({ bin_type: 'shelf', is_reserve: false, is_pick_bin: true });
    }
    setNodeModalOpen(true);
  };

  const handleEditNode = (node) => {
    setEditingNode(node);
    setNodeLevel(node.level);
    setNodeParentId(node.parentId);
    nodeForm.setFieldsValue(node.data || {});
    setNodeModalOpen(true);
  };

  const handleDeleteNode = async (node) => {
    try {
      const url = getUpdateUrl(node.level, node.entityId);
      await api.delete(url);
      message.success(`${LEVEL_LABELS[node.level]?.singular || 'Item'} deleted`);
      fetchWarehouseHierarchy(selectedWarehouse.id);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleNodeSubmit = async () => {
    try {
      const values = await nodeForm.validateFields();
      setNodeSubmitting(true);
      if (editingNode) {
        const url = getUpdateUrl(nodeLevel, editingNode.entityId);
        await api.put(url, values);
        message.success(`${LEVEL_LABELS[nodeLevel]?.singular || 'Item'} updated`);
      } else {
        const url = getApiUrl(nodeLevel, nodeParentId);
        await api.post(url, values);
        message.success(`${LEVEL_LABELS[nodeLevel]?.singular || 'Item'} created`);
      }
      setNodeModalOpen(false);
      nodeForm.resetFields();
      setEditingNode(null);
      fetchWarehouseHierarchy(selectedWarehouse.id);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setNodeSubmitting(false);
    }
  };

  const handleGenerateBarcode = (node) => {
    const code = node.data?.barcode || node.data?.code || node.title;
    setBarcodeValue(code);
    setBarcodeModalOpen(true);
  };

  const handleExport = () => {
    try {
      // BUG-FE-070: backend serializer returns `type`/`phone` (and `is_active`),
      // not `warehouse_type`/`contact_phone`/`status`. Read both for safety so
      // the export populates regardless of which field the API supplies.
      const exportData = warehouses.map((wh) => ({
        'Name': wh.name || wh.warehouse_name || '',
        'Code': wh.code || '',
        'Type': wh.type || wh.warehouse_type || '',
        'Status': wh.is_active === false ? 'Inactive' : (wh.status || 'Active'),
        'City': wh.city || '',
        'State': wh.state || '',
        'Pincode': wh.pincode || '',
        'Contact Person': wh.contact_person || '',
        'Contact Phone': wh.phone || wh.contact_phone || '',
        'Address': wh.address || '',
      }));
      downloadExcel(exportData, 'warehouses', 'Warehouses');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const onTreeSelect = (keys, info) => {
    if (info.selected && info.node) {
      setSelectedNode(info.node);
    } else {
      setSelectedNode(null);
    }
  };

  const titleRender = (nodeData) => {
    const levelLabel = LEVEL_LABELS[nodeData.level];
    const nextLevels = { location: 'line', line: 'rack', rack: 'bin' };
    const nextLevel = nextLevels[nodeData.level];

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span>{nodeData.title}</span>
        <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
          {levelLabel?.singular}
        </Tag>
        <Space size={0} style={{ marginLeft: 4 }}>
          {nextLevel && (
            <Tooltip title={`Add ${LEVEL_LABELS[nextLevel]?.singular}`}>
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined style={{ fontSize: 11 }} />}
                onClick={(e) => { e.stopPropagation(); handleAddNode(nextLevel, nodeData.entityId); }}
                style={{ padding: '0 3px' }}
              />
            </Tooltip>
          )}
          <Button
            type="text"
            size="small"
            icon={<EditOutlined style={{ fontSize: 11 }} />}
            onClick={(e) => { e.stopPropagation(); handleEditNode(nodeData); }}
            style={{ padding: '0 3px' }}
          />
          {nodeData.level === 'bin' && (
            <Tooltip title="Generate Barcode">
              <Button
                type="text"
                size="small"
                icon={<BarcodeOutlined style={{ fontSize: 11 }} />}
                onClick={(e) => { e.stopPropagation(); handleGenerateBarcode(nodeData); }}
                style={{ padding: '0 3px' }}
              />
            </Tooltip>
          )}
          <Popconfirm
            title={`Delete this ${levelLabel?.singular?.toLowerCase()}?`}
            // BUG-FE-073: Antd v5 Popconfirm `onConfirm` is invoked without a
            // synthetic event — `e` is undefined. Drop the e.stopPropagation
            // call (we already stop propagation on the trigger button click)
            // and just delegate to the handler.
            onConfirm={() => handleDeleteNode(nodeData)}
            onCancel={() => {}}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined style={{ fontSize: 11 }} />}
              onClick={(e) => e.stopPropagation()}
              style={{ padding: '0 3px' }}
            />
          </Popconfirm>
        </Space>
      </span>
    );
  };

  const renderNodeDetail = () => {
    if (!selectedNode) return <Empty description="Select a node to see details" />;
    const nd = selectedNode.data || {};
    if (selectedNode.level === 'bin') {
      return (
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="Name">{nd.name || nd.code || '-'}</Descriptions.Item>
          <Descriptions.Item label="Code">{nd.code || '-'}</Descriptions.Item>
          <Descriptions.Item label="Bin Type">{nd.bin_type || '-'}</Descriptions.Item>
          <Descriptions.Item label="Capacity">{nd.capacity ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="Reserve Bin">{nd.is_reserve ? 'Yes' : 'No'}</Descriptions.Item>
          <Descriptions.Item label="Pick Bin">{nd.is_pick_bin ? 'Yes' : 'No'}</Descriptions.Item>
          {/* BUG-FE-072: only render barcode rows when the backend actually
              returns a value; the column does not exist in the bin model so
              new rows would never have it set. */}
          {nd.barcode && (
            <>
              <Descriptions.Item label="Barcode" span={2}>{nd.barcode}</Descriptions.Item>
              <Descriptions.Item label="Barcode Display" span={2}>
                <BarcodeDisplay value={nd.barcode} type="CODE128" height={50} />
              </Descriptions.Item>
            </>
          )}
        </Descriptions>
      );
    }
    return (
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="Name">{nd.name || '-'}</Descriptions.Item>
        <Descriptions.Item label="Code">{nd.code || '-'}</Descriptions.Item>
        <Descriptions.Item label="Description" span={2}>{nd.description || '-'}</Descriptions.Item>
        {nd.barcode && <Descriptions.Item label="Barcode" span={2}>{nd.barcode}</Descriptions.Item>}
      </Descriptions>
    );
  };

  const filteredWarehouses = warehouses.filter((wh) => {
    const searchLower = searchText.toLowerCase().trim();
    if (!searchLower) return true;
    const name = (wh.name || wh.warehouse_name || '').toLowerCase();
    const code = (wh.code || '').toLowerCase();
    const type = (wh.warehouse_type || '').toLowerCase();
    const parentName = (wh.parent_name || '').toLowerCase();
    return (
      name.includes(searchLower) ||
      code.includes(searchLower) ||
      type.includes(searchLower) ||
      parentName.includes(searchLower)
    );
  });

  return (
    <div>
      <PageHeader title="Warehouses" subtitle="Manage warehouses and storage hierarchy">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            Export
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAddWarehouse}>
            Add Warehouse
          </Button>
        </Space>
      </PageHeader>

      <Row gutter={16}>
        <Col xs={24} md={8} lg={6}>
          <Card
            title="Warehouses"
            size="small"
            style={{ minHeight: 600 }}
            extra={
              <Button size="small" icon={<ReloadOutlined />} onClick={fetchWarehouses} loading={loading} />
            }
          >
            <Input
              placeholder="Search warehouses..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ marginBottom: 12 }}
              allowClear
            />
            {loading ? (
              <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
            ) : filteredWarehouses.length === 0 ? (
              <Empty description="No warehouses found" />
            ) : (
              <div style={{ maxHeight: '500px', overflowY: 'auto', paddingRight: '4px' }}>
                <List
                  size="small"
                  dataSource={filteredWarehouses}
                  renderItem={(wh) => (
                    <List.Item
                      onClick={() => setSelectedWarehouse(wh)}
                      style={{
                        cursor: 'pointer',
                        background: selectedWarehouse?.id === wh.id ? '#e6f7ff' : 'transparent',
                        borderRadius: 4,
                        padding: '8px 12px',
                        marginBottom: 4,
                      }}
                      actions={[
                        <Tooltip key="floor-plan" title="View 2D Floor Plan">
                          <Button
                            type="text"
                            size="small"
                            icon={<BlockOutlined />}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/warehouse/floor-plan?warehouse_id=${wh.id}`);
                            }}
                          />
                        </Tooltip>,
                        <Button
                          key="edit"
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={(e) => { e.stopPropagation(); handleEditWarehouse(wh); }}
                        />,
                        <Popconfirm
                          key="del"
                          title="Delete warehouse?"
                          onConfirm={() => handleDeleteWarehouse(wh.id)}
                          onCancel={(e) => { if (e) e.stopPropagation(); }}
                          okButtonProps={{ danger: true }}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </Popconfirm>,
                      ]}
                    >
                      <List.Item.Meta
                        avatar={<HomeOutlined style={{ fontSize: 18, color: '#eb2f96', marginTop: 4 }} />}
                        title={
                          <Tooltip title={wh.name || wh.warehouse_name} placement="topLeft">
                            <div style={{
                              fontWeight: 600,
                              fontSize: '13px',
                              color: '#262626',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {wh.name || wh.warehouse_name}
                            </div>
                          </Tooltip>
                        }
                        description={
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px', overflow: 'hidden' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                              {wh.warehouse_type && (
                                <Tag style={{ fontSize: '10px', lineHeight: '16px', margin: 0, padding: '0 4px', textTransform: 'capitalize' }}>
                                  {wh.warehouse_type}
                                </Tag>
                              )}
                              {wh.code && (
                                <span style={{ fontSize: '11px', color: '#8c8c8c', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px' }} title={wh.code}>
                                  {wh.code}
                                </span>
                              )}
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                              {wh.parent_name && (
                                <Tooltip title={`Parent: ${wh.parent_name}`} placement="topLeft">
                                  <Tag color="purple" style={{ fontSize: '10px', lineHeight: '16px', margin: 0, padding: '0 4px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    Parent: {wh.parent_name}
                                  </Tag>
                                </Tooltip>
                              )}
                              <Tag color={wh.status === 'active' || wh.is_active ? 'green' : 'red'} style={{ fontSize: '10px', lineHeight: '16px', margin: 0, padding: '0 4px' }}>
                                {wh.status === 'active' || wh.is_active ? 'Active' : 'Inactive'}
                              </Tag>
                            </div>
                          </div>
                        }
                      />
                    </List.Item>
                  )}
                />
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} md={16} lg={18}>
          {selectedWarehouse ? (
            <Card
              title={
                <Space>
                  <HomeOutlined />
                  <span>{selectedWarehouse.name || selectedWarehouse.warehouse_name} - Hierarchy</span>
                </Space>
              }
              size="small"
              style={{ minHeight: 600 }}
              extra={
                <Space>
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => handleAddNode('location', selectedWarehouse.id)}
                  >
                    Add Location
                  </Button>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={() => fetchWarehouseHierarchy(selectedWarehouse.id)}
                    loading={treeLoading}
                  />
                </Space>
              }
            >
              <Row gutter={16}>
                <Col xs={24} md={14}>
                  {treeLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
                  ) : treeData.length === 0 ? (
                    <Empty description="No locations configured. Add a location to get started." />
                  ) : (
                    <Tree
                      showIcon
                      treeData={treeData}
                      expandedKeys={expandedKeys}
                      onExpand={setExpandedKeys}
                      onSelect={onTreeSelect}
                      titleRender={titleRender}
                      blockNode
                      style={{ minHeight: 400 }}
                    />
                  )}
                </Col>
                <Col xs={24} md={10}>
                  <Card title="Node Details" size="small" style={{ minHeight: 300 }}>
                    {renderNodeDetail()}
                  </Card>
                </Col>
              </Row>
            </Card>
          ) : (
            <Card style={{ minHeight: 600, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <Empty description="Select a warehouse from the list to view its hierarchy" />
            </Card>
          )}
        </Col>
      </Row>



      {/* Node Modal */}
      <Modal
        title={
          editingNode
            ? `Edit ${LEVEL_LABELS[nodeLevel]?.singular || 'Item'}`
            : `Add ${LEVEL_LABELS[nodeLevel]?.singular || 'Item'}`
        }
        open={nodeModalOpen}
        onOk={handleNodeSubmit}
        onCancel={() => { setNodeModalOpen(false); setEditingNode(null); nodeForm.resetFields(); }}
        confirmLoading={nodeSubmitting}
        okText={editingNode ? 'Update' : 'Create'}
        destroyOnHidden
        width={500}
      >
        <Form form={nodeForm} layout="vertical" style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Required' }]}>
                <Input placeholder="Enter name" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="code" label="Code">
                <Input placeholder="Code" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Description" />
          </Form.Item>
          {nodeLevel === 'bin' && (
            <>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item name="bin_type" label="Bin Type">
                    <Select options={BIN_TYPES} placeholder="Select type" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="capacity" label="Capacity">
                    <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item name="is_reserve" label="Reserve Bin" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="is_pick_bin" label="Pick Bin" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Col>
              </Row>
              {/* BUG-FE-072: barcode column is not in the bin schema yet —
                  hide the input rather than silently dropping the value on
                  submit. Restore once the column is added. */}
            </>
          )}
        </Form>
      </Modal>

      {/* Barcode Modal */}
      <Modal
        title="Barcode"
        open={barcodeModalOpen}
        onCancel={() => setBarcodeModalOpen(false)}
        footer={[
          <Button key="close" onClick={() => setBarcodeModalOpen(false)}>Close</Button>,
          <Button key="print" type="primary" onClick={() => window.print()}>Print</Button>,
        ]}
        width={400}
      >
        <div style={{ textAlign: 'center', padding: 24 }}>
          <BarcodeDisplay value={barcodeValue} type="CODE128" height={80} />
        </div>
      </Modal>
    </div>
  );
};

export default Warehouses;

