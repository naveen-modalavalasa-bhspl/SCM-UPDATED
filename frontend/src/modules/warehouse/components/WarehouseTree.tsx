// @ts-nocheck
import React, { useState, useEffect, useCallback } from 'react';
import { TreeSelect, Spin, message } from 'antd';
import api from '../config/api';

const LEVEL_CONFIG = {
  warehouse: { childType: 'location', label: 'Locations' },
  location: { childType: 'line', label: 'Lines' },
  line: { childType: 'rack', label: 'Racks' },
  rack: { childType: 'bin', label: 'Bins' },
  bin: { childType: null, label: null },
};

const WarehouseTree = ({
  value,
  onChange,
  placeholder = 'Select warehouse location...',
  disabled = false,
  allowClear = true,
  style,
  selectableLevel,
  treeCheckable = false,
  apiBase = '/masters/warehouses',
  multiple = false,
}) => {
  const [treeData, setTreeData] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchWarehouses = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get(apiBase, {
        params: { page_size: 100 },
      });
      const data = response.data;
      const warehouses = data.items || data.data || data || [];
      // AntD treeDataSimpleMode links children by `pId` -> parent.id. Use the
      // string `value` as the id so child pId (parent's value) matches; mixing
      // numeric warehouse.id with string child pId silently broke expansion.
      const nodes = warehouses.map((wh) => ({
        id: `warehouse-${wh.id}`,
        pId: 0,
        value: `warehouse-${wh.id}`,
        title: wh.name || wh.warehouse_name,
        key: `warehouse-${wh.id}`,
        level: 'warehouse',
        entityId: wh.id,
        isLeaf: false,
        selectable: selectableLevel ? selectableLevel === 'warehouse' : true,
      }));
      setTreeData(nodes);
    } catch (error) {
      console.error('WarehouseTree fetch error:', error);
      setTreeData([]);
    } finally {
      setLoading(false);
    }
  }, [apiBase, selectableLevel]);

  useEffect(() => {
    fetchWarehouses();
  }, [fetchWarehouses]);

  const onLoadData = async (treeNode) => {
    const { level, entityId } = treeNode;
    const levelConfig = LEVEL_CONFIG[level];

    if (!levelConfig || !levelConfig.childType) {
      return;
    }

    const childType = levelConfig.childType;

    try {
      const response = await api.get(
        `${apiBase}/${entityId}/${childType}s`,
        { params: { page_size: 200 } }
      );
      const data = response.data;
      const children = data.items || data.data || data || [];

      // Bug fix BUG_0089: when nothing's configured at this level (no
      // locations/lines/racks/bins yet), give the user a clear message
      // instead of silently showing an empty tree.
      if (children.length === 0) {
        message.warning(
          `No ${LEVEL_CONFIG[level]?.label || childType + 's'} configured under "${treeNode.title}". Add ${childType}s under Warehouse Settings → Layout.`
        );
        return;
      }

      const childNodes = children.map((child) => ({
        // id must equal `value` (and parent's value -> our pId) so AntDs
        // simple-mode tree resolves the link.
        id: `${childType}-${child.id}`,
        pId: treeNode.value,
        value: `${childType}-${child.id}`,
        title: child.name || child.code || child.label,
        key: `${childType}-${child.id}`,
        level: childType,
        entityId: child.id,
        isLeaf: childType === 'bin',
        selectable: selectableLevel ? selectableLevel === childType : true,
      }));

      setTreeData((prevData) => [...prevData, ...childNodes]);
    } catch (error) {
      console.error(`Failed to load ${childType}s:`, error);
      message.error(
        `Failed to load ${childType}s: ${error?.response?.data?.detail || error?.message || ''}`
      );
    }
  };

  const handleChange = (val) => {
    if (onChange) {
      onChange(val);
    }
  };

  if (loading && treeData.length === 0) {
    return (
      <div style={{ padding: '8px 0' }}>
        <Spin size="small" /> Loading warehouses...
      </div>
    );
  }

  return (
    <TreeSelect
      treeDataSimpleMode
      value={value}
      onChange={handleChange}
      treeData={treeData}
      loadData={onLoadData}
      placeholder={placeholder}
      disabled={disabled}
      allowClear={allowClear}
      style={{ width: '100%', ...style }}
      treeCheckable={treeCheckable}
      multiple={multiple}
      showSearch
      treeNodeFilterProp="title"
      dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
    />
  );
};

export default WarehouseTree;
